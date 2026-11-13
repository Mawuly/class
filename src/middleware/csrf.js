'use strict';
const { AppError } = require('../utils/errors');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A cross-site <form> cannot set custom headers, and a cross-site fetch() that sets one
 * triggers a CORS preflight we never approve. Requiring the header therefore blocks CSRF.
 */
function requireXhr(req, res, next) {
  if (SAFE.has(req.method)) return next();
  if (req.get('X-Requested-With') !== 'XMLHttpRequest') {
    return next(new AppError(403, 'Missing X-Requested-With header'));
  }
  next();
}

module.exports = { requireXhr };
