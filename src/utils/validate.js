'use strict';
const { AppError } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseId(value, what = 'Item') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new AppError(404, `${what} not found`);
  return n;
}

/** At least 8 characters, with at least one letter and one number. Returns an error or null. */
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  if (pw.length > 128) return 'Password must be at most 128 characters';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must include at least one letter and one number';
  return null;
}

module.exports = { EMAIL_RE, parseId, passwordProblem };
