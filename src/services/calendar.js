'use strict';
// Calendar export: a one-off .ics download, a single booking, and a private subscription feed.
const crypto = require('crypto');
const db = require('../db');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');
const ics = require('../utils/ics');
const { audit } = require('./audit');

const STATUS = { approved: 'CONFIRMED', pending: 'TENTATIVE', rejected: 'CANCELLED', cancelled: 'CANCELLED' };
const CATEGORY = { lecture: 'Lecture', tutorial: 'Tutorial', lab: 'Practical', exam: 'Exam', meeting: 'Meeting', study: 'Study', event: 'Event' };

const COLUMNS = `b.id, b.title, b.category, b.course_code, b.date, b.start_time, b.end_time, b.attendees, b.notes,
  b.status, b.series_id, b.updated_at, r.id AS room_id, r.code AS room_code, r.name AS room_name,
  bl.name AS building_name`;
const FROM = 'bookings b JOIN rooms r ON r.id = b.room_id JOIN buildings bl ON bl.id = r.building_id';

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function toEvent(b, baseUrl) {
  const label = `${b.course_code ? `${b.course_code} · ` : ''}${b.title}`;
  const description = [
    b.status === 'pending' ? 'Awaiting approval by the timetable office.' : null,
    b.status === 'cancelled' ? 'Cancelled.' : null,
    b.status === 'rejected' ? 'Not approved.' : null,
    `${CATEGORY[b.category] || b.category} · ${b.attendees} ${b.attendees === 1 ? 'person' : 'people'}`,
    b.series_id ? 'Weekly booking.' : null,
    b.notes ? `Notes: ${b.notes}` : null,
    baseUrl ? `Room timetable: ${baseUrl}/#/room/${b.room_id}?date=${b.date}` : null,
  ].filter(Boolean).join('\n');
  return {
    uid: `booking-${b.id}@lecture-rooms`,
    start: { date: b.date, time: b.start_time },
    end: { date: b.date, time: b.end_time },
    summary: `${b.status === 'pending' ? '[Awaiting approval] ' : ''}${label} (${b.room_code})`,
    location: `${b.room_code}, ${b.room_name}, ${b.building_name}`,
    description,
    status: STATUS[b.status],
    // Must go up whenever the booking changes, so calendar apps replace their copy.
    sequence: Math.floor(new Date(b.updated_at).getTime() / 1000) - 1_700_000_000,
    url: baseUrl ? `${baseUrl}/#/room/${b.room_id}?date=${b.date}` : undefined,
  };
}

/** Upcoming approved and pending bookings, for a one-off download. */
async function download(user, baseUrl) {
  const today = t.localDate();
  const rows = await db.all(
    `SELECT ${COLUMNS} FROM ${FROM}
     WHERE b.user_id = ? AND b.status IN ('approved', 'pending') AND b.date >= ?
     ORDER BY b.date, b.start_time LIMIT 1000`,
    [user.id, today],
  );
  return ics.calendar({ name: `Lecture Rooms: ${user.name}`, events: rows.map((b) => toEvent(b, baseUrl)) });
}

/** One booking, for "Add to calendar" after booking. Yours, or any booking for an admin. */
async function single(user, id, baseUrl) {
  const b = await db.get(`SELECT ${COLUMNS}, b.user_id FROM ${FROM} WHERE b.id = ?`, [id]);
  if (!b || (b.user_id !== user.id && user.role !== 'admin')) throw new AppError(404, 'Booking not found');
  return { body: ics.calendar({ name: `${b.room_code} booking`, events: [toEvent(b, baseUrl)] }), room: b.room_code, date: b.date };
}

/**
 * The subscription feed. Includes the last 60 days and everything ahead, and keeps cancelled
 * and rejected bookings (marked CANCELLED) so subscribed calendars remove them.
 */
async function feed(token, baseUrl) {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token || '')) throw new AppError(404, 'Calendar not found');
  const user = await db.get('SELECT id, name FROM users WHERE calendar_token_hash = ? AND is_active', [hash(token)]);
  if (!user) throw new AppError(404, 'Calendar not found');
  const rows = await db.all(
    `SELECT ${COLUMNS} FROM ${FROM} WHERE b.user_id = ? AND b.date >= ? ORDER BY b.date, b.start_time LIMIT 2000`,
    [user.id, t.addDays(t.localDate(), -60)],
  );
  return ics.calendar({ name: `Lecture Rooms: ${user.name}`, events: rows.map((b) => toEvent(b, baseUrl)) });
}

async function feedStatus(user) {
  const row = await db.get('SELECT calendar_token_created_at FROM users WHERE id = ? AND calendar_token_hash IS NOT NULL', [user.id]);
  return { hasFeed: Boolean(row), createdAt: row?.calendar_token_created_at ?? null };
}

/** Creates a subscription link, replacing any earlier one (which stops working). Shown once. */
async function createFeed(user, baseUrl, { ip } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const { replaced } = await db.get(
    `WITH old AS (SELECT calendar_token_hash IS NOT NULL AS replaced FROM users WHERE id = ?)
     UPDATE users SET calendar_token_hash = ?, calendar_token_created_at = now() WHERE id = ?
     RETURNING (SELECT replaced FROM old)`,
    [user.id, hash(token), user.id],
  );
  await audit({ userId: user.id, action: replaced ? 'calendar.replace_link' : 'calendar.create_link', entity: 'user', entityId: user.id, ip });
  const https = `${baseUrl}/api/calendar/feed/${token}.ics`;
  const webcal = https.replace(/^https?:/, 'webcal:');
  return {
    url: https,
    webcal,
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent('Lecture Rooms')}`,
  };
}

async function removeFeed(user, { ip } = {}) {
  const { changes } = await db.run(
    'UPDATE users SET calendar_token_hash = NULL, calendar_token_created_at = NULL WHERE id = ? AND calendar_token_hash IS NOT NULL',
    [user.id],
  );
  if (changes) await audit({ userId: user.id, action: 'calendar.remove_link', entity: 'user', entityId: user.id, ip });
}

module.exports = { download, single, feed, feedStatus, createFeed, removeFeed, toEvent };
