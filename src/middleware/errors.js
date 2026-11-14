'use strict';
const { AppError } = require('../utils/errors');
const { databaseHint } = require('../utils/dbErrors');

function notFound(req, res, next) {
  next(new AppError(404, 'Not found'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, ...(err.details || {}) });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  console.error(err);
  const hint = databaseHint(err);
  if (hint) return res.status(503).json({ error: `The database is not reachable. ${hint}` });
  res.status(500).json({ error: 'Something went wrong on our side' });
}

module.exports = { notFound, errorHandler };
