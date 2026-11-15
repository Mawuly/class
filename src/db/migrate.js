'use strict';
// `npm run db:migrate` (and `npm run vercel-build` on each Vercel deploy): brings the database up
// to the current schema version and loads the rooms into an empty database. Safe to run again:
// every statement in schema.sql is idempotent, and nothing is ever dropped or emptied.
const fs = require('fs');
const path = require('path');

/** Runs the whole schema file (used by the tests on their own database). */
async function migrate(db) {
  await db.pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

module.exports = { migrate };

if (require.main === module) {
  const config = require('../config');
  if (config.problems.length) {
    // A deploy without a database (e.g. a preview with no variables) still builds; the API then
    // explains what is missing at /api/health, and sets the database up on its first request.
    console.warn(`[migrate] skipped: ${config.problems.join('. ')}`);
    process.exit(0);
  }
  const db = require('./index');
  const { ensureReady, SCHEMA_VERSION } = require('./setup');
  ensureReady()
    .then(() => { console.log(`[migrate] database is at schema version ${SCHEMA_VERSION}.`); return db.pool.end(); })
    .catch((err) => { console.error(`[migrate] ${err.message}`); process.exit(1); });
}
