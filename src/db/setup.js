'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('./index');
const { seedReference, seedDemo } = require('./seed');
const { switchToCampus, applyCampusArea } = require('./campus');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const LOCK_ID = 72_710_001; // any fixed number; only this app uses it

// Bump whenever schema.sql changes. Every statement in it is idempotent, so an existing database
// is brought up to date by running the whole file again once.
//   1: first release   2: access_requests (staff verification) and app_meta
//   3: password reset columns on users   4: append-only audit log, audit indexes
//   5: calendar subscription token on users   6: password_resets (emailed codes)
//   7: phone numbers and text-message codes   8: door codes, check-in, released bookings
//   9: room_blocks (temporary closures) and the triggers that keep them apart from bookings
//   10: booking window in app_meta   11: bookings.supervisor   12: bookings.checked_out_at
//   13: users.google_sub (Continue with Google)   14: building locations, check-in location label
//   15: check-in radius up to 5 km (campus-wide area)
const SCHEMA_VERSION = 15;

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
    const campus = (await x.get("SELECT value FROM app_meta WHERE key = 'campus'"))?.value || null;
    if (rooms === 0) {
      console.log(`[setup] loading the buildings and rooms of campus "${config.campus}"`);
      await seedReference(x);
    } else if (campus !== config.campus) {
      // A database set up before the real campus was added (it has the demo rooms): switch once.
      const changed = await switchToCampus(x, config.campus);
      await x.run(
        `INSERT INTO app_meta (key, value) VALUES ('campus', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [config.campus],
      );
      console.log(`[setup] switched to campus "${config.campus}"`, changed);
    }
    // Every building starts with the campus-wide check-in area (once), until it gets its own point.
    const located = await applyCampusArea(x, config.campus);
    if (located) console.log(`[setup] gave ${located} buildings the campus-wide check-in area`);
    // Demo rooms kept for bookings that were still coming up: hide them once those are over.
    await x.run(
      `UPDATE rooms r SET is_active = false WHERE r.is_active AND r.code LIKE 'DEMO-%' AND NOT EXISTS (
         SELECT 1 FROM bookings b WHERE b.room_id = r.id AND b.status IN ('pending', 'approved')
           AND (b.date > current_date OR (b.date = current_date AND b.end_time > localtime)))`,
    );
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
