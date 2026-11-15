'use strict';
// Password reset with a 6-digit code sent by email.
//
//   Expiry        10 minutes, and only the newest code a person was sent works
//   Wrong tries   5, then the code is used up
//   Sending       at most once a minute and 5 times an hour per person (plus the per-address
//                 sign-in rate limit)
//   Storage       an HMAC of the code, keyed with the server secret: a database copy alone
//                 can't be used to try codes offline
//   Privacy       the answer to "send me a code" is the same whether or not the email exists
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const { AppError } = require('../utils/errors');
const { passwordProblem } = require('../utils/validate');
const { audit } = require('./audit');
const { notify } = require('./notifications');
const mail = require('./mail');

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MIN_GAP_SECONDS = 60;
const MAX_PER_HOUR = 5;

const keyed = (code) => crypto.createHmac('sha256', config.jwtSecret).update(`password-reset:${code}`).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** 6 random digits, shown as "482 913" so it's easy to read and type. */
function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function message(name, code) {
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const text = [
    `Hello ${name.split(' ')[0]},`,
    '',
    `Your Lecture Rooms code is ${spaced}`,
    '',
    `Enter it on the reset page to choose a new password. It works once, for ${CODE_MINUTES} minutes.`,
    '',
    "If you didn't ask for this, you can ignore this email: your password hasn't changed.",
    'Never share this code. The timetable office will never ask you for it.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#12161C;font-family:Arial,sans-serif;color:#EDE6DA">
<div style="max-width:420px;margin:0 auto">
<p style="font-family:Georgia,serif;font-size:22px;margin:0 0 20px">Lecture Rooms</p>
<p style="margin:0 0 12px">Hello ${name.split(' ')[0].replace(/[<>&"]/g, '')},</p>
<p style="margin:0 0 8px">Your code to reset your password:</p>
<p style="font-family:'Courier New',monospace;font-size:34px;letter-spacing:6px;margin:0 0 16px;padding:14px 18px;background:#EDE6DA;color:#12161C;border-radius:6px;text-align:center">${spaced}</p>
<p style="margin:0 0 16px;font-size:14px">It works once, for ${CODE_MINUTES} minutes.</p>
<p style="margin:0;font-size:12px;opacity:.7">If you didn't ask for this, ignore this email: your password hasn't changed. Never share this code; the timetable office will never ask for it.</p>
</div></body></html>`;
  return { subject: `Your Lecture Rooms code: ${spaced}`, text, html };
}

/**
 * Sends a code if the email belongs to an active account and the limits allow it.
 * Always resolves the same way, so the caller can't learn whether the account exists.
 */
async function requestCode(email, { ip } = {}) {
  const user = await db.get('SELECT id, name, email FROM users WHERE lower(email) = ? AND is_active', [email]);
  if (!user) return;
  const { recent, lastHour } = await db.get(
    `SELECT count(*) FILTER (WHERE created_at > now() - make_interval(secs => ?))::int AS recent,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS "lastHour"
     FROM password_resets WHERE user_id = ?`,
    [MIN_GAP_SECONDS, user.id],
  );
  if (recent || lastHour >= MAX_PER_HOUR) {
    await audit({ userId: user.id, action: 'auth.reset_code_throttled', entity: 'user', entityId: user.id, ip });
    return;
  }
  const code = newCode();
  await db.tx(async (x) => {
    // Only the newest code works.
    await x.run('UPDATE password_resets SET used_at = now() WHERE user_id = ? AND used_at IS NULL', [user.id]);
    await x.run(
      `INSERT INTO password_resets (user_id, code_hash, expires_at, ip)
       VALUES (?, ?, now() + make_interval(mins => ?), ?)`,
      [user.id, keyed(code), CODE_MINUTES, ip],
    );
    await audit({ userId: user.id, action: 'auth.reset_code_sent', entity: 'user', entityId: user.id, ip }, x);
  });
  try {
    await mail.send({ to: user.email, ...message(user.name, code) });
  } catch (err) {
    // Don't reveal the failure to the requester (that would confirm the account exists); log it.
    console.error('[mail] could not send a reset code:', err.message);
    await audit({ userId: user.id, action: 'auth.reset_code_failed', entity: 'user', entityId: user.id,
      details: { error: String(err.message).slice(0, 200) }, ip });
  }
}

const WRONG = 'That code is wrong or has expired. Check the latest email, or ask for a new code.';

/** Checks the code and sets the new password. Returns the user, ready to be signed in. */
async function resetWithCode(email, code, newPassword, { ip } = {}) {
  const clean = String(code ?? '').replace(/\D/g, '');
  const pwError = passwordProblem(newPassword);
  if (pwError) throw new AppError(400, pwError);
  return db.tx(async (x) => {
    const row = await x.get(
      `SELECT p.id, p.code_hash, p.attempts, u.id AS user_id, u.name
       FROM password_resets p JOIN users u ON u.id = p.user_id
       WHERE lower(u.email) = ? AND u.is_active AND p.used_at IS NULL AND p.expires_at > now()
       ORDER BY p.id DESC LIMIT 1 FOR UPDATE OF p`,
      [email],
    );
    if (!row) throw new AppError(400, WRONG);
    if (clean.length !== 6 || !sameHash(keyed(clean), row.code_hash)) {
      const attempts = row.attempts + 1;
      await x.run(`UPDATE password_resets SET attempts = ?${attempts >= MAX_ATTEMPTS ? ', used_at = now()' : ''} WHERE id = ?`, [attempts, row.id]);
      await audit({ userId: row.user_id, action: 'auth.reset_code_wrong', entity: 'user', entityId: row.user_id,
        details: { attempt: attempts }, ip }, x);
      // The failed attempt must be saved, so commit rather than throwing inside the transaction.
      return { error: attempts >= MAX_ATTEMPTS ? 'Too many wrong codes. Ask for a new code.' : WRONG };
    }
    const user = await x.get(
      `UPDATE users SET password_hash = ?, must_change_password = false, temp_password_expires_at = NULL,
              session_version = session_version + 1, password_changed_at = now()
       WHERE id = ? RETURNING id, name, email, role, department, index_number, must_change_password, session_version`,
      [await bcrypt.hash(newPassword, config.bcryptCost), row.user_id],
    );
    await x.run('UPDATE password_resets SET used_at = now() WHERE user_id = ? AND used_at IS NULL', [row.user_id]);
    await audit({ userId: row.user_id, action: 'auth.reset_with_code', entity: 'user', entityId: row.user_id, ip }, x);
    await notify(row.user_id, 'Your password was changed using a code sent to your email. If this wasn’t you, tell the timetable office straight away.', x);
    return { user };
  }).then((r) => {
    if (r.error) throw new AppError(400, r.error);
    return r.user;
  });
}

module.exports = { requestCode, resetWithCode, newCode, message, CODE_MINUTES, MAX_ATTEMPTS };
