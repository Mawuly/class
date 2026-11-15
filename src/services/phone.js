'use strict';
// Adding and verifying a phone number. A number only receives password reset codes after its
// owner has typed in a code sent to it.
const db = require('../db');
const { AppError } = require('../utils/errors');
const { normalizeGhana, displayPhone } = require('../utils/phone');
const otp = require('../utils/otp');
const { audit } = require('./audit');
const sms = require('./sms');

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MIN_GAP_SECONDS = 60;
const MAX_PER_HOUR = 5;

/** Texts a code to a new number. The number isn't saved until the code comes back. */
async function startVerification(user, input, { ip } = {}) {
  if (!sms.enabled()) throw new AppError(503, 'Text messages are not set up on this site');
  const phone = normalizeGhana(input);
  if (!phone) throw new AppError(400, 'Enter a Ghana mobile number, e.g. 024 123 4567');
  const taken = await db.get('SELECT 1 AS yes FROM users WHERE phone = ? AND phone_verified_at IS NOT NULL AND id <> ?', [phone, user.id]);
  if (taken) throw new AppError(409, 'That number is already verified on another account');
  const { recent, lastHour } = await db.get(
    `SELECT count(*) FILTER (WHERE created_at > now() - make_interval(secs => ?))::int AS recent,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS "lastHour"
     FROM phone_verifications WHERE user_id = ?`,
    [MIN_GAP_SECONDS, user.id],
  );
  if (recent) throw new AppError(429, 'Please wait a minute before asking for another code');
  if (lastHour >= MAX_PER_HOUR) throw new AppError(429, 'Too many codes this hour. Try again later.');

  const code = otp.newCode();
  await db.tx(async (x) => {
    await x.run('UPDATE phone_verifications SET used_at = now() WHERE user_id = ? AND used_at IS NULL', [user.id]);
    await x.run(
      `INSERT INTO phone_verifications (user_id, phone, code_hash, expires_at, ip)
       VALUES (?, ?, ?, now() + make_interval(mins => ?), ?)`,
      [user.id, phone, otp.keyed('verify-phone', code), CODE_MINUTES, ip],
    );
  });
  try {
    await sms.send(phone, `Lecture Rooms: ${otp.spaced(code)} is your code to confirm this phone number. Valid ${CODE_MINUTES} min.`);
  } catch (err) {
    console.error('[sms] could not send a verification code:', err.message);
    throw new AppError(502, 'The text message could not be sent. Check the number, or try again in a few minutes.');
  }
  await audit({ userId: user.id, action: 'phone.code_sent', entity: 'user', entityId: user.id, ip });
  return { phone: displayPhone(phone), minutes: CODE_MINUTES };
}

/** Checks the code and saves the number as verified. */
async function confirm(user, code, { ip } = {}) {
  const clean = otp.digits(code);
  const result = await db.tx(async (x) => {
    const row = await x.get(
      `SELECT id, phone, code_hash, attempts FROM phone_verifications
       WHERE user_id = ? AND used_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [user.id],
    );
    if (!row) return { error: 'That code has expired. Ask for a new one.' };
    if (clean.length !== 6 || !otp.sameHash(otp.keyed('verify-phone', clean), row.code_hash)) {
      const attempts = row.attempts + 1;
      await x.run(`UPDATE phone_verifications SET attempts = ?${attempts >= MAX_ATTEMPTS ? ', used_at = now()' : ''} WHERE id = ?`, [attempts, row.id]);
      return { error: attempts >= MAX_ATTEMPTS ? 'Too many wrong codes. Ask for a new one.' : 'That code is wrong. Check the latest text message.' };
    }
    // Someone else may have verified the same number meanwhile.
    const taken = await x.get('SELECT 1 AS yes FROM users WHERE phone = ? AND phone_verified_at IS NOT NULL AND id <> ?', [row.phone, user.id]);
    if (taken) return { error: 'That number is already verified on another account' };
    await x.run('UPDATE phone_verifications SET used_at = now() WHERE id = ?', [row.id]);
    await x.run('UPDATE users SET phone = ?, phone_verified_at = now() WHERE id = ?', [row.phone, user.id]);
    await audit({ userId: user.id, action: 'phone.verified', entity: 'user', entityId: user.id, ip }, x);
    return { phone: row.phone };
  });
  if (result.error) throw new AppError(400, result.error);
  return { phone: displayPhone(result.phone) };
}

async function remove(user, { ip } = {}) {
  const { changes } = await db.run('UPDATE users SET phone = NULL, phone_verified_at = NULL WHERE id = ? AND phone IS NOT NULL', [user.id]);
  if (changes) await audit({ userId: user.id, action: 'phone.removed', entity: 'user', entityId: user.id, ip });
}

module.exports = { startVerification, confirm, remove, CODE_MINUTES };
