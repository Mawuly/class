'use strict';
// The booking window (opening time, closing time, longest booking), edited on /admin → Settings.
// Stored in app_meta and copied into config.booking, which every rule check reads. Each server
// re-reads it at most every 30 seconds, so a change reaches every Vercel instance quickly.
const db = require('../db');
const config = require('../config');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');
const { audit } = require('./audit');

const rules = config.booking;
const KEYS = {
  open: 'booking_open', close: 'booking_close', maxHours: 'booking_max_hours',
  checkInLocation: 'checkin_location', studentApproval: 'student_approval',
  eventClose: 'event_close', eventMaxHours: 'event_max_hours',
};
const LOCATION_MODES = ['required', 'flag'];
const APPROVAL_MODES = ['auto', 'manual'];
const EARLIEST = '05:00';
const LATEST = '23:00';

function current() {
  return {
    open: rules.open, close: rules.close, maxHours: rules.maxHours,
    checkInLocation: rules.checkInLocation, studentApproval: rules.studentApproval,
    eventClose: rules.eventClose, eventMaxHours: rules.eventMaxHours,
  };
}

/** Returns an error message, or null when the window is acceptable. */
function problem({ open, close, maxHours, checkInLocation = 'required', studentApproval = 'auto', eventClose = '05:00', eventMaxHours = 12 }) {
  if (!t.isValidTime(eventClose) || t.toMinutes(eventClose) % 30 || eventClose > '12:00') return 'Event rooms must close on the hour or half hour, by 12:00 the next day';
  if (!Number.isInteger(eventMaxHours) || eventMaxHours < 1 || eventMaxHours > 24) return 'The longest event booking must be 1 to 24 whole hours';
  if (!LOCATION_MODES.includes(checkInLocation)) return 'Check-in location must be "required" or "flag"';
  if (!APPROVAL_MODES.includes(studentApproval)) return 'Student requests must be "auto" or "manual"';
  if (!t.isValidTime(open) || !t.isValidTime(close)) return 'Opening and closing times must be in HH:MM format';
  if (t.toMinutes(open) % 30 || t.toMinutes(close) % 30) return 'Opening and closing times must be on the hour or half hour';
  if (open < EARLIEST || close > LATEST) return `Rooms can open from ${EARLIEST} and close by ${LATEST}`;
  if (t.toMinutes(close) - t.toMinutes(open) < 60) return 'Closing time must be at least an hour after opening time';
  if (!Number.isInteger(maxHours) || maxHours < 1 || maxHours > 6) return 'The longest booking must be 1 to 6 whole hours';
  if (maxHours * 60 > t.toMinutes(close) - t.toMinutes(open)) return 'The longest booking is longer than the day the rooms are open';
  return null;
}

/** Reads the window from the database into config.booking. Bad stored values are ignored. */
async function load(exec = db) {
  const rows = await exec.all('SELECT key, value FROM app_meta WHERE key IN (?, ?, ?, ?, ?, ?, ?)', Object.values(KEYS));
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const next = {
    open: v[KEYS.open] ?? rules.open,
    close: v[KEYS.close] ?? rules.close,
    maxHours: v[KEYS.maxHours] == null ? rules.maxHours : Number(v[KEYS.maxHours]),
    checkInLocation: v[KEYS.checkInLocation] ?? rules.checkInLocation,
    studentApproval: v[KEYS.studentApproval] ?? rules.studentApproval,
    eventClose: v[KEYS.eventClose] ?? rules.eventClose,
    eventMaxHours: v[KEYS.eventMaxHours] == null ? rules.eventMaxHours : Number(v[KEYS.eventMaxHours]),
  };
  if (!problem(next)) Object.assign(rules, next);
  return current();
}

let loadedAt = 0;
async function loadIfStale() {
  if (!config.isTest && Date.now() - loadedAt < 30_000) return;
  loadedAt = Date.now();
  await load();
}

async function update(admin, input, { ip } = {}) {
  const before = current();
  const next = {
    open: input.open === undefined ? before.open : String(input.open).trim(),
    close: input.close === undefined ? before.close : String(input.close).trim(),
    maxHours: input.maxHours === undefined ? before.maxHours : Number(input.maxHours),
    checkInLocation: input.checkInLocation === undefined ? before.checkInLocation : String(input.checkInLocation),
    studentApproval: input.studentApproval === undefined ? before.studentApproval : String(input.studentApproval),
    eventClose: input.eventClose === undefined ? before.eventClose : String(input.eventClose).trim(),
    eventMaxHours: input.eventMaxHours === undefined ? before.eventMaxHours : Number(input.eventMaxHours),
  };
  const err = problem(next);
  if (err) throw new AppError(400, err);
  await db.tx(async (x) => {
    for (const [k, key] of Object.entries(KEYS)) {
      await x.run(
        'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, String(next[k])],
      );
    }
    const changed = Object.fromEntries(Object.keys(KEYS).filter((k) => next[k] !== before[k]).map((k) => [k, { from: before[k], to: next[k] }]));
    await audit({ userId: admin.id, action: 'settings.update', details: changed, ip }, x);
  });
  Object.assign(rules, next);
  loadedAt = Date.now();
  return current();
}

module.exports = { current, load, loadIfStale, update, problem };
