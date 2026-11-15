'use strict';
// "Continue with Google": OpenID Connect, authorization-code flow with PKCE, done on the server.
// The browser never holds a Google key or token; the server exchanges the code with Google,
// reads who the person is, and signs them in to their account here with the usual cookie.
// Accounts stay in our own users table (no Supabase Auth).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const { AppError } = require('../utils/errors');
const { audit } = require('./audit');
const { notify } = require('./notifications');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const configured = () => Boolean(config.google.clientId && config.google.clientSecret);

const b64url = (buf) => buf.toString('base64url');
const random = () => b64url(crypto.randomBytes(32));

/** The Google page to send the person to, plus what we must remember until they come back. */
function start(redirectUri) {
  const state = random();
  const nonce = random();
  const verifier = random();
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  // With a university domain set, Google shows that domain's accounts first.
  if (config.allowedEmailDomain) params.set('hd', config.allowedEmailDomain);
  return { url: `${AUTH_URL}?${params}`, state, nonce, verifier };
}

/**
 * Swaps the one-time code for the person's identity. The ID token comes straight from Google's
 * token endpoint over TLS, so its claims are checked (issuer, audience, expiry, nonce, verified
 * email) without fetching Google's signing keys, as Google's OpenID documentation allows.
 */
async function identify({ code, verifier, nonce, redirectUri }) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code',
        client_id: config.google.clientId, client_secret: config.google.clientSecret,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new AppError(502, 'Could not reach Google. Please try again.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.id_token !== 'string') {
    console.error('[google] token exchange failed', res.status, body.error, body.error_description);
    throw new AppError(502, body.error === 'redirect_uri_mismatch'
      ? 'Google sign-in is not set up for this address yet (redirect URI mismatch).'
      : 'Google did not accept the sign-in. Please try again.');
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    throw new AppError(502, 'Google sent an unreadable answer. Please try again.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.includes(claims.iss) || claims.aud !== config.google.clientId || !(claims.exp > now) || claims.nonce !== nonce) {
    throw new AppError(401, 'Google sign-in could not be verified. Please try again.');
  }
  if (!claims.email || claims.email_verified !== true) {
    throw new AppError(401, 'Your Google account email is not verified. Verify it with Google first.');
  }
  return {
    sub: String(claims.sub),
    email: String(claims.email).toLowerCase(),
    name: String(claims.name || claims.email.split('@')[0]).trim().slice(0, 80),
  };
}

const USER_COLUMNS = `id, name, email, role, department, index_number, is_active, must_change_password,
  session_version, phone, phone_verified_at, google_sub`;

/** A password nobody knows: for accounts made with Google, or whose old password stops working. */
const unusablePassword = () => bcrypt.hash(crypto.randomBytes(32).toString('hex'), config.bcryptCost);

/**
 * Finds or creates the account for a Google identity and returns it, ready for a session.
 * - Known Google account: signs in.
 * - Same email as an existing account, first time with Google: links them. Sign-up here never
 *   proved anyone owned the email, but Google has, so the old password stops working and other
 *   sessions end. Someone who registered with another person's email can't keep using it.
 * - New: a student account (an admin if the email is in ADMIN_EMAILS), like ordinary sign-up.
 */
async function signIn(identity, { ip } = {}) {
  const { sub, email, name } = identity;
  if (config.allowedEmailDomain && !email.endsWith(`@${config.allowedEmailDomain}`)) {
    throw new AppError(403, `Use your @${config.allowedEmailDomain} Google account`);
  }
  return db.tx(async (x) => {
    let user = await x.get(`SELECT ${USER_COLUMNS} FROM users WHERE google_sub = ?`, [sub])
      ?? await x.get(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = ? FOR UPDATE`, [email]);
    let created = false;

    if (!user) {
      const role = config.adminEmails.includes(email) ? 'admin' : 'student';
      user = await x.get(
        `INSERT INTO users (name, email, password_hash, role, google_sub) VALUES (?, ?, ?, ?, ?) RETURNING ${USER_COLUMNS}`,
        [name.length >= 2 ? name : email, email, await unusablePassword(), role, sub],
      );
      created = true;
      await audit({ userId: user.id, action: 'auth.register', entity: 'user', entityId: user.id, details: { via: 'google' }, ip }, x);
    } else if (user.google_sub && user.google_sub !== sub) {
      // The email belongs to a different Google account than the one linked before.
      throw new AppError(409, 'This email is already linked to a different Google account.');
    } else if (!user.google_sub) {
      if (!user.is_active) throw new AppError(403, 'This account has been deactivated. Contact the timetable office.');
      user = await x.get(
        `UPDATE users SET google_sub = ?, password_hash = ?, must_change_password = false, temp_password_expires_at = NULL,
                session_version = session_version + 1, password_changed_at = now()
         WHERE id = ? RETURNING ${USER_COLUMNS}`,
        [sub, await unusablePassword(), user.id],
      );
      await audit({ userId: user.id, action: 'auth.google_linked', entity: 'user', entityId: user.id, ip }, x);
      await notify(user.id, 'You signed in with Google. Your old password no longer works: keep using "Continue with Google", '
        + 'or use "Forgot password" to set a new one.', x);
    }

    if (!user.is_active) throw new AppError(403, 'This account has been deactivated. Contact the timetable office.');
    if (user.must_change_password) {
      // Google has proved who this is, so a temporary password from the office is no longer needed.
      user = await x.get(
        `UPDATE users SET must_change_password = false, temp_password_expires_at = NULL WHERE id = ? RETURNING ${USER_COLUMNS}`,
        [user.id],
      );
    }
    if (config.adminEmails.includes(email) && user.role !== 'admin') {
      user = await x.get(`UPDATE users SET role = 'admin' WHERE id = ? RETURNING ${USER_COLUMNS}`, [user.id]);
      await audit({ userId: user.id, action: 'user.promote_admin', entity: 'user', entityId: user.id, details: { via: 'ADMIN_EMAILS' }, ip }, x);
    }
    await audit({ userId: user.id, action: 'auth.login', details: { via: 'google' }, ip }, x);
    return { user, created };
  });
}

module.exports = { configured, start, identify, signIn, AUTH_URL, TOKEN_URL };
