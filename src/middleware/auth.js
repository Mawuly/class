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

function setSession(res, user) {
  const token = jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: config.jwtTtlSeconds });
  res.cookie(COOKIE, token, cookieOptions);
}

function clearSession(res) {
  const { maxAge, ...opts } = cookieOptions;
  res.clearCookie(COOKIE, opts);
}

/**
 * Reads the session cookie and reloads the user from the database on every request,
 * so a role change or deactivation takes effect immediately.
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
    'SELECT id, name, email, role, department, index_number, is_active FROM users WHERE id = ?',
    [payload.sub],
  );
  if (user && user.is_active) req.user = user;
  else clearSession(res);
  next();
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

module.exports = { authenticate, requireAuth, requireRole, setSession, clearSession };
