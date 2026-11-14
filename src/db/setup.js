'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('./index');
const { seedReference, seedDemo } = require('./seed');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const LOCK_ID = 72_710_001; // any fixed number; only this app uses it

let ready = null;

/**
 * Creates the tables and loads the rooms the first time the app meets an empty database,
 * so a fresh Supabase project works with no manual steps. Runs once per server instance.
 * An advisory lock stops two Vercel instances that start together from both doing it.
 */
function ensureReady() {
  ready ??= db.tx(async (x) => {
    await x.run('SELECT pg_advisory_xact_lock(?)', [LOCK_ID]);
    const { exists } = await x.get("SELECT to_regclass('public.bookings') IS NOT NULL AS exists");
    if (!exists) {
      console.log('[setup] creating tables');
      await x.run(schema);
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

module.exports = { ensureReady, resetSetupState };
