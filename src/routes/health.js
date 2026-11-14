'use strict';
const express = require('express');
const config = require('../config');
const db = require('../db');

const router = express.Router();

/** Turns a database error into a plain-English hint. Never includes the connection string. */
function hint(err) {
  const code = err.code || '';
  const msg = String(err.message || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'The database host name was not found. Copy the connection string again from Supabase → Connect.';
  }
  if (['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNREFUSED'].includes(code) || /timeout/i.test(msg)) {
    return "Could not reach the database. Supabase's direct connection (db.<ref>.supabase.co) only works over IPv6, "
      + 'which Vercel does not support: use the Transaction pooler string (…pooler.supabase.com:6543) instead.';
  }
  if (code === '28P01' || /password authentication failed/i.test(msg)) {
    return 'Wrong database password. Reset it in Supabase → Project Settings → Database, update DATABASE_URL, then redeploy. '
      + 'If the password has symbols such as @ # / ?, they must be URL-encoded in the connection string.';
  }
  if (/tenant or user not found/i.test(msg)) {
    return 'Supabase did not recognise the user. With the pooler, the user name must be postgres.<project-ref>, '
      + 'exactly as shown in Supabase → Connect.';
  }
  if (code === '42P01') {
    return 'The tables do not exist yet. Run `npm run db:seed:rooms` once against the Supabase database (see README).';
  }
  if (/certificate/i.test(msg) || code.startsWith('SELF_SIGNED') || code.startsWith('UNABLE_TO')) {
    return 'TLS certificate check failed. Check DATABASE_CA holds the Supabase CA certificate, or remove it.';
  }
  return 'Unexpected database error. See the function logs in Vercel for details.';
}

// Shows whether the server is configured and can reach the database. Safe to open in a browser.
router.get('/', async (req, res) => {
  const report = { ok: true, problems: [...config.problems], database: 'not checked' };
  if (config.isProd && !process.env.DATABASE_URL) return res.status(503).json({ ...report, ok: false });
  try {
    const { rooms } = await db.get('SELECT count(*)::int AS rooms FROM rooms');
    report.database = `connected, ${rooms} rooms`;
    if (rooms === 0) report.problems.push('The rooms table is empty. Run `npm run db:seed:rooms` (see README).');
  } catch (err) {
    report.database = `failed (${err.code || 'error'})`;
    report.problems.push(hint(err));
  }
  report.ok = report.problems.length === 0;
  res.status(report.ok ? 200 : 503).json(report);
});

module.exports = router;
