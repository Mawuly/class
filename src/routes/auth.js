'use strict';
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const db = require('../db');
const { AppError } = require('../utils/errors');
const { EMAIL_RE, passwordProblem } = require('../utils/validate');
const { audit } = require('../services/audit');
const mail = require('../services/mail');
const sms = require('../services/sms');
const phone = require('../services/phone');
const { displayPhone } = require('../utils/phone');
const passwordReset = require('../services/passwordReset');
const { setSession, clearSession, requireAuth } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const google = require('../services/google');

const router = express.Router();

// Note: the default store is in memory, so on Vercel each function instance counts separately.
const authLimiter = rateLimit({
  ...config.authRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});

// Compared against when the email does not exist, so a wrong email takes as long as a wrong password.
let dummyHash;
function getDummyHash() {
  dummyHash ??= bcrypt.hash(crypto.randomBytes(16).toString('hex'), config.bcryptCost);
  return dummyHash;
}

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, department: u.department, indexNumber: u.index_number,
  mustChangePassword: Boolean(u.must_change_password),
  phone: u.phone_verified_at ? displayPhone(u.phone) : null,
});

router.post('/register', authLimiter, async (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const password = req.body.password;
  const department = String(req.body.department ?? '').trim().slice(0, 80) || null;
  const indexNumber = String(req.body.indexNumber ?? '').trim().slice(0, 30) || null;

  if (name.length < 2 || name.length > 80) throw new AppError(400, 'Enter your full name');
  if (!EMAIL_RE.test(email) || email.length > 254) throw new AppError(400, 'Enter a valid email address');
  if (config.allowedEmailDomain && !email.endsWith(`@${config.allowedEmailDomain}`)) {
    throw new AppError(400, `Use your @${config.allowedEmailDomain} email address`);
  }
  const pwError = passwordProblem(password);
  if (pwError) throw new AppError(400, pwError);

  const hash = await bcrypt.hash(password, config.bcryptCost);
  let user;
  try {
    // Everyone who registers is a student, except emails listed in ADMIN_EMAILS (set by the
    // site owner in Vercel). Only an admin can grant other roles.
    const role = config.adminEmails.includes(email) ? 'admin' : 'student';
    user = await db.get(
      `INSERT INTO users (name, email, password_hash, role, department, index_number)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id, name, email, role, department, index_number`,
      [name, email, hash, role, department, indexNumber],
    );
  } catch (err) {
    if (err.code === '23505') throw new AppError(409, 'An account with that email already exists');
    throw err;
  }
  await audit({ userId: user.id, action: 'auth.register', entity: 'user', entityId: user.id, ip: req.ip });
  setSession(res, user);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', authLimiter, async (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 128) : '';

  const user = await db.get(
    `SELECT id, name, email, role, department, index_number, password_hash, is_active,
            must_change_password, temp_password_expires_at, session_version, phone, phone_verified_at
     FROM users WHERE lower(email) = ?`,
    [email],
  );
  const ok = await bcrypt.compare(password, user ? user.password_hash : await getDummyHash());

  if (!user || !ok || !user.is_active) {
    await audit({ userId: user?.id ?? null, action: 'auth.login_failed', details: { email: email.slice(0, 254) }, ip: req.ip });
    throw new AppError(401, 'Email or password is incorrect');
  }
  // Only someone holding the temporary password reaches this, so saying why is safe.
  if (user.must_change_password && user.temp_password_expires_at && new Date(user.temp_password_expires_at) < new Date()) {
    await audit({ userId: user.id, action: 'auth.login_failed', details: { reason: 'temporary password expired' }, ip: req.ip });
    throw new AppError(401, 'This temporary password has expired. Ask the timetable office for a new one.');
  }
  if (config.adminEmails.includes(user.email.toLowerCase()) && user.role !== 'admin') {
    // Registered before their email was added to ADMIN_EMAILS.
    await db.run("UPDATE users SET role = 'admin' WHERE id = ?", [user.id]);
    await audit({ userId: user.id, action: 'user.promote_admin', entity: 'user', entityId: user.id, details: { via: 'ADMIN_EMAILS' }, ip: req.ip });
    user.role = 'admin';
  }
  await audit({ userId: user.id, action: 'auth.login', ip: req.ip });
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/change-password', requireAuth, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const row = await db.get('SELECT password_hash, has_password FROM users WHERE id = ?', [req.user.id]);
  // An account made with Google has no password yet: it sets one without a current password.
  if (row.has_password && (typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword.slice(0, 128), row.password_hash)))) {
    throw new AppError(400, 'Your current password is incorrect');
  }
  const pwError = passwordProblem(newPassword);
  if (pwError) throw new AppError(400, pwError);
  if (newPassword === currentPassword) throw new AppError(400, 'Choose a password different from the current one');
  // Bumping the session version signs out every other device; this one gets a fresh cookie below.
  const user = await db.get(
    `UPDATE users SET password_hash = ?, has_password = true, must_change_password = false, temp_password_expires_at = NULL,
            session_version = session_version + 1, password_changed_at = now()
     WHERE id = ? RETURNING id, name, email, role, department, index_number, must_change_password, session_version,
                 phone, phone_verified_at`,
    [await bcrypt.hash(newPassword, config.bcryptCost), req.user.id],
  );
  await audit({ userId: user.id, action: 'auth.change_password', entity: 'user', entityId: user.id,
    details: req.user.must_change_password ? { after: 'temporary password' } : null, ip: req.ip });
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

/*
 * "Forgot password". The answer is the same whether or not the email exists, so nobody can use
 * this to find out who has an account.
 */
const codesOn = () => sms.enabled() || mail.enabled();
const channels = () => ({ sms: sms.enabled(), email: mail.enabled() });

/* ---------- Profile ----------------------------------------------------------------- */

// The profile page: your details, how you sign in, and a summary of your bookings.
router.get('/profile', requireAuth, async (req, res) => {
  const u = await db.get(
    `SELECT id, name, email, role, department, index_number, created_at, has_password, google_sub IS NOT NULL AS google,
            phone, phone_verified_at
     FROM users WHERE id = ?`,
    [req.user.id],
  );
  const since = new Date(Date.now() - 120 * 86_400_000);
  const activity = await db.get(
    `SELECT count(*) FILTER (WHERE status IN ('approved', 'released'))::int AS bookings,
            coalesce(sum(extract(epoch FROM end_time - start_time) / 3600) FILTER (WHERE status = 'approved'), 0)::float AS hours,
            count(*) FILTER (WHERE checked_in_at IS NOT NULL)::int AS checked_in,
            count(*) FILTER (WHERE status = 'released')::int AS released,
            count(*) FILTER (WHERE status IN ('pending', 'approved') AND date >= current_date)::int AS upcoming
     FROM bookings WHERE user_id = ? AND kind = 'booking' AND date >= ?::date`,
    [req.user.id, since.toISOString().slice(0, 10)],
  );
  // Overnight bookings: add the hours after midnight, which are stored on the next date.
  const extra = await db.get(
    `SELECT coalesce(sum(extract(epoch FROM c.end_time - c.start_time) / 3600), 0)::float AS hours
     FROM bookings c JOIN bookings p ON p.id = c.parent_id
     WHERE p.user_id = ? AND c.status = 'approved' AND p.date >= ?::date`,
    [req.user.id, since.toISOString().slice(0, 10)],
  );
  res.json({
    user: {
      ...publicUser(u), createdAt: u.created_at, googleLinked: u.google, hasPassword: u.has_password,
    },
    activity: { ...activity, hours: Math.round((activity.hours + extra.hours) * 10) / 10, sinceDays: 120 },
  });
});

// Your own details. Email and role are not changed here: email is how you sign in, and roles are
// granted by the timetable office.
router.patch('/profile', requireAuth, async (req, res) => {
  const name = req.body?.name === undefined ? req.user.name : String(req.body.name).trim().replace(/\s+/g, ' ');
  const department = req.body?.department === undefined ? req.user.department : (String(req.body.department).trim().slice(0, 80) || null);
  const indexNumber = req.body?.indexNumber === undefined ? req.user.index_number : (String(req.body.indexNumber).trim().slice(0, 30) || null);
  if (name.length < 2 || name.length > 80) throw new AppError(400, 'Enter your full name (2 to 80 characters)');
  const changed = Object.fromEntries([['name', name, req.user.name], ['department', department, req.user.department],
    ['index_number', indexNumber, req.user.index_number]].filter(([, a, b]) => a !== b).map(([k, a, b]) => [k, { from: b, to: a }]));
  const user = await db.get(
    `UPDATE users SET name = ?, department = ?, index_number = ? WHERE id = ?
     RETURNING id, name, email, role, department, index_number, must_change_password, phone, phone_verified_at`,
    [name, department, indexNumber, req.user.id],
  );
  if (Object.keys(changed).length) {
    await audit({ userId: req.user.id, action: 'user.update_self', entity: 'user', entityId: req.user.id, details: changed, ip: req.ip });
  }
  res.json({ user: publicUser(user) });
});

// Signs out every other device (phones, lab computers) and keeps this one signed in.
router.post('/sign-out-others', requireAuth, async (req, res) => {
  const user = await db.get('UPDATE users SET session_version = session_version + 1 WHERE id = ? RETURNING id, session_version', [req.user.id]);
  await audit({ userId: req.user.id, action: 'auth.sign_out_others', entity: 'user', entityId: req.user.id, ip: req.ip });
  setSession(res, user);
  res.json({ ok: true });
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254);
  // With text messages or email set up, a 6-digit code is sent (by text to a verified phone,
  // else by email). The reply never says whether the account exists.
  if (codesOn()) {
    if (EMAIL_RE.test(email)) await passwordReset.requestCode(email, { ip: req.ip });
    return res.json({ ok: true, method: 'code', minutes: passwordReset.CODE_MINUTES, channels: channels() });
  }
  // With neither, the timetable office is told and resets it in person.
  if (EMAIL_RE.test(email)) {
    const user = await db.get('SELECT id, name, email FROM users WHERE lower(email) = ? AND is_active', [email]);
    if (user) await passwordReset.notifyOffice(user, req.ip);
  }
  res.json({ ok: true, method: 'office' });
});

/* ---------- Your phone number, for reset codes by text ----------------------------- */

router.post('/phone', requireAuth, authLimiter, async (req, res) => {
  res.json(await phone.startVerification(req.user, req.body?.phone, { ip: req.ip }));
});
router.post('/phone/verify', requireAuth, authLimiter, async (req, res) => {
  res.json(await phone.confirm(req.user, req.body?.code, { ip: req.ip }));
});
router.delete('/phone', requireAuth, async (req, res) => {
  await phone.remove(req.user, { ip: req.ip });
  res.json({ ok: true });
});

/** How "Forgot password" works on this site, so the page can explain the right steps. */
router.get('/options', (req, res) => {
  res.json({ resetByCode: codesOn(), channels: channels(), codeMinutes: passwordReset.CODE_MINUTES, google: google.configured() });
});

/** Second step: the emailed code and a new password. Signs the person in on success. */
router.post('/reset-password', authLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254);
  const user = await passwordReset.resetWithCode(email, req.body?.code, req.body?.newPassword, { ip: req.ip });
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

/* ---------- Continue with Google ---------------------------------------------------- */

// Where people may be sent back to after Google: our own pages only, never another site.
const NEXT_RE = /^\/(admin|account\.html|booking\.html|door\?c=[A-Za-z0-9-]{6,7})?(#[\w/-]*)?$/;
const safeNext = (v) => (typeof v === 'string' && NEXT_RE.test(v) ? v : '/');
const GOOGLE_COOKIE = 'g_oauth';
const googleCookie = { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/api/auth/google' };
const redirectUri = (req) => config.google.redirectUri || `${req.protocol}://${req.get('host')}/api/auth/google/callback`;

/** Back to the page they came from, with a message the page shows. */
function backWithError(res, next, message) {
  const [path, hash = ''] = next.split('#');
  res.redirect(303, `${path}${path.includes('?') ? '&' : '?'}auth_error=${encodeURIComponent(message)}${hash ? `#${hash}` : ''}`);
}

// Step 1: the "Continue with Google" link. Remembers (in a short-lived signed cookie) what is
// needed to check Google's answer, then sends the person to Google.
router.get('/google/start', authLimiter, (req, res) => {
  const next = safeNext(req.query.next);
  if (!google.configured()) return backWithError(res, next, 'Google sign-in is not set up yet. Use your email and password.');
  const { url, state, nonce, verifier } = google.start(redirectUri(req));
  res.cookie(GOOGLE_COOKIE, jwt.sign({ state, nonce, verifier, next }, config.jwtSecret, { expiresIn: '10m' }),
    { ...googleCookie, maxAge: 10 * 60 * 1000 });
  res.redirect(302, url);
});

// Step 2: Google sends the person back here with a one-time code.
router.get('/google/callback', authLimiter, async (req, res) => {
  let saved = null;
  try { saved = jwt.verify(req.cookies?.[GOOGLE_COOKIE] || '', config.jwtSecret); } catch { /* missing or expired */ }
  res.clearCookie(GOOGLE_COOKIE, googleCookie);
  const next = safeNext(saved?.next);
  if (!saved) return backWithError(res, next, 'Google sign-in took too long or was started in another browser. Please try again.');
  if (req.query.error) return backWithError(res, next, 'Google sign-in was cancelled.');
  const state = String(req.query.state || '');
  if (state.length !== saved.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved.state))) {
    return backWithError(res, next, 'Google sign-in could not be verified. Please try again.');
  }
  try {
    const identity = await google.identify({ code: String(req.query.code || ''), verifier: saved.verifier, nonce: saved.nonce, redirectUri: redirectUri(req) });
    const { user } = await google.signIn(identity, { ip: req.ip });
    setSession(res, user);
    res.redirect(303, next);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    await audit({ action: 'auth.login_failed', details: { via: 'google', reason: err.message.slice(0, 120) }, ip: req.ip });
    backWithError(res, next, err.message);
  }
});

module.exports = router;
