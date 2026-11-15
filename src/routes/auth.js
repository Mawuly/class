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
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword.slice(0, 128), row.password_hash))) {
    throw new AppError(400, 'Your current password is incorrect');
  }
  const pwError = passwordProblem(newPassword);
  if (pwError) throw new AppError(400, pwError);
  if (newPassword === currentPassword) throw new AppError(400, 'Choose a password different from the current one');
  // Bumping the session version signs out every other device; this one gets a fresh cookie below.
  const user = await db.get(
    `UPDATE users SET password_hash = ?, must_change_password = false, temp_password_expires_at = NULL,
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
  res.json({ resetByCode: codesOn(), channels: channels(), codeMinutes: passwordReset.CODE_MINUTES });
});

/** Second step: the emailed code and a new password. Signs the person in on success. */
router.post('/reset-password', authLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254);
  const user = await passwordReset.resetWithCode(email, req.body?.code, req.body?.newPassword, { ip: req.ip });
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

module.exports = router;
