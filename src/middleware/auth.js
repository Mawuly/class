'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { AppError } = require('../utils/errors');

const COOKIE = 'token';
const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
  path: '/',
  maxAge: config.jwtTtlSeconds * 1000,
};

/** The token carries the account's session version; bumping it signs out every device. */
function setSession(res, user) {
  const token = jwt.sign({ sub: user.id, v: user.session_version ?? 1 }, config.jwtSecret, { expiresIn: config.jwtTtlSeconds });
  res.cookie(COOKIE, token, cookieOptions);
}

function clearSession(res) {
  const { maxAge, ...opts } = cookieOptions;
  res.clearCookie(COOKIE, opts);
}

/**
 * Reads the session cookie and reloads the user from the database on every request,
 * so a role change, deactivation or password reset takes effect immediately.
 */
async function authenticate(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return next();
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    clearSession(res);
    return next();
  }
  const user = await db.get(
    `SELECT id, name, email, role, department, index_number, is_active, must_change_password, session_version,
            phone, phone_verified_at
     FROM users WHERE id = ?`,
    [payload.sub],
  );
  // Tokens issued before session versions existed count as version 1.
  if (user && user.is_active && (payload.v ?? 1) === user.session_version) req.user = user;
  else clearSession(res);
  next();
}

// While someone is signed in with a temporary password, only these work.
const ALLOWED_DURING_CHANGE = ['/auth/me', '/auth/change-password', '/auth/logout'];

/** After an admin reset, nothing else works until the person chooses their own password. */
function requirePasswordChosen(req, res, next) {
  if (!req.user?.must_change_password || ALLOWED_DURING_CHANGE.includes(req.path)) return next();
  next(new AppError(403, 'Choose a new password to continue', { mustChangePassword: true }));
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new AppError(401, 'Please sign in'));
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new AppError(401, 'Please sign in'));
    if (!roles.includes(req.user.role)) return next(new AppError(403, 'You do not have permission to do that'));
    next();
  };
}

module.exports = { authenticate, requirePasswordChosen, requireAuth, requireRole, setSession, clearSession };
