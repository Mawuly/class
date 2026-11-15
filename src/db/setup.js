'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('./index');
const { seedReference, seedDemo } = require('./seed');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const LOCK_ID = 72_710_001; // any fixed number; only this app uses it

// Bump whenever schema.sql changes. Every statement in it is idempotent, so an existing database
// is brought up to date by running the whole file again once.
//   1: first release   2: access_requests (staff verification) and app_meta
//   3: password reset columns on users   4: append-only audit log, audit indexes
//   5: calendar subscription token on users   6: password_resets (emailed codes)
const SCHEMA_VERSION = 6;

let ready = null;

async function schemaVersion(x) {
  const { has } = await x.get("SELECT to_regclass('public.app_meta') IS NOT NULL AS has");
  if (!has) return 0;
  const row = await x.get("SELECT value FROM app_meta WHERE key = 'schema_version'");
  return row ? Number(row.value) : 0;
}

/**
 * Creates or updates the tables, and loads the rooms the first time the app meets an empty
 * database, so a fresh or older Supabase database works with no manual steps. Runs once per
 * server instance. An advisory lock stops two Vercel instances from doing it at the same time.
 */
function ensureReady() {
  ready ??= db.tx(async (x) => {
    await x.run('SELECT pg_advisory_xact_lock(?)', [LOCK_ID]);
    const version = await schemaVersion(x);
    if (version < SCHEMA_VERSION) {
      console.log(`[setup] bringing the database schema from version ${version} to ${SCHEMA_VERSION}`);
      await x.run(schema);
      await x.run(
        `INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [String(SCHEMA_VERSION)],
      );
    }
    const { rooms } = await x.get('SELECT count(*)::int AS rooms FROM rooms');
    if (rooms === 0) {
      console.log('[setup] loading buildings and rooms');
      await seedReference(x);
    }
    if (config.seedDemo) {
      const { users } = await x.get('SELECT count(*)::int AS users FROM users');
      if (users === 0) {
        console.log('[setup] adding demo users and bookings (SEED_DEMO)');
        await seedDemo(x, { includeAdmin: false });
      }
    }
  }).catch((err) => {
    ready = null; // try again on the next request
    throw err;
  });
  return ready;
}

/** For tests that drop the tables and want setup to run again. */
function resetSetupState() {
  ready = null;
}

module.exports = { ensureReady, resetSetupState, SCHEMA_VERSION };
