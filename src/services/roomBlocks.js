'use strict';
// Temporary closures: the timetable office makes a room unavailable for a time range on a date
// (maintenance, an exam, an event). The room stays active and is bookable again afterwards.
// Existing bookings are never cancelled by a closure: the office cancels or rejects them first.
const db = require('../db');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');
const { audit } = require('./audit');

const EXCLUSION_VIOLATION = '23P01';
const HOLDING = "('pending', 'approved')";

/** Closures overlapping [start, end) in one room on one date. */
async function blockClashes(exec, roomId, date, start, end) {
  return exec.all(
    `SELECT id, start_time, end_time, reason FROM room_blocks
     WHERE room_id = ? AND date = ? AND start_time < ? AND end_time > ? ORDER BY start_time`,
    [roomId, date, end, start],
  );
}

/** Every closure on a date, optionally only in some rooms. */
async function onDate(date, roomIds = null, exec = db) {
  return exec.all(
    `SELECT id, room_id, start_time, end_time, reason FROM room_blocks
     WHERE date = ? ${roomIds ? 'AND room_id = ANY(?::int[])' : ''} ORDER BY start_time`,
    roomIds ? [date, roomIds] : [date],
  );
}

/** For the admin list: upcoming closures (or one room's / one date's). */
async function list({ roomId, date } = {}) {
  const where = [];
  const args = [];
  if (roomId) { where.push('rb.room_id = ?'); args.push(Number(roomId)); }
  if (date) {
    if (!t.isValidDate(String(date))) throw new AppError(400, 'Date must be a valid date (YYYY-MM-DD)');
    where.push('rb.date = ?'); args.push(String(date));
  } else {
    const today = t.localDate();
    where.push('(rb.date > ? OR (rb.date = ? AND rb.end_time > ?))'); args.push(today, today, t.localTime());
  }
  return db.all(
    `SELECT rb.id, rb.room_id, r.code AS room_code, r.name AS room_name, rb.date, rb.start_time, rb.end_time,
            rb.reason, rb.created_at, u.name AS created_by_name
     FROM room_blocks rb JOIN rooms r ON r.id = rb.room_id JOIN users u ON u.id = rb.created_by
     WHERE ${where.join(' AND ')} ORDER BY rb.date, rb.start_time, r.code LIMIT 500`,
    args,
  );
}

function clean(input) {
  const b = {
    roomId: Number(input.roomId),
    date: String(input.date ?? '').trim(),
    start: String(input.start ?? '').trim(),
    end: String(input.end ?? '').trim(),
    reason: String(input.reason ?? '').trim().replace(/\s+/g, ' '),
  };
  if (!Number.isInteger(b.roomId) || b.roomId < 1) throw new AppError(400, 'Choose a room');
  if (!t.isValidDate(b.date)) throw new AppError(400, 'Date must be a valid date (YYYY-MM-DD)');
  if (!t.isValidTime(b.start) || !t.isValidTime(b.end)) throw new AppError(400, 'Times must be in HH:MM format');
  // Closures may be half an hour long; only bookings must be whole hours.
  if (t.toMinutes(b.start) % 30 || t.toMinutes(b.end) % 30) throw new AppError(400, 'Times must be on the hour or half hour');
  if (b.end <= b.start) throw new AppError(400, 'End time must be after start time');
  const today = t.localDate();
  if (b.date < today || (b.date === today && b.end <= t.localTime())) throw new AppError(400, 'That time has already passed');
  if (b.reason.length < 3 || b.reason.length > 300) throw new AppError(400, 'Give a reason of 3 to 300 characters');
  return b;
}

async function create(admin, input, { ip } = {}) {
  const b = clean(input);
  const room = await db.get('SELECT id, code FROM rooms WHERE id = ?', [b.roomId]);
  if (!room) throw new AppError(404, 'Room not found');
  const busy = (details) => new AppError(409, `${room.code} already has a booking or an unavailable period at that time`, details);

  const id = await db.tx(async (x) => {
    // Friendly checks first, with what is in the way; the triggers in schema.sql are the backstop.
    const bookings = await x.all(
      `SELECT b.id, b.title, b.course_code, b.start_time, b.end_time, b.status, u.name AS user_name
       FROM bookings b JOIN users u ON u.id = b.user_id
       WHERE b.room_id = ? AND b.date = ? AND b.status IN ${HOLDING} AND b.start_time < ? AND b.end_time > ?
       ORDER BY b.start_time`,
      [b.roomId, b.date, b.end, b.start],
    );
    const blocks = await blockClashes(x, b.roomId, b.date, b.start, b.end);
    if (bookings.length || blocks.length) {
      throw busy({ clash: bookings.length ? 'booking' : 'block', bookings, blocks });
    }
    const row = await x.get(
      `INSERT INTO room_blocks (room_id, date, start_time, end_time, reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [b.roomId, b.date, b.start, b.end, b.reason, admin.id],
    );
    await audit({ userId: admin.id, action: 'room.block', entity: 'room', entityId: b.roomId,
      details: { block: row.id, date: b.date, start: b.start, end: b.end, reason: b.reason }, ip }, x);
    return row.id;
  }).catch((err) => {
    if (err.code === EXCLUSION_VIOLATION) throw busy();
    throw err;
  });
  return db.get('SELECT id, room_id, date, start_time, end_time, reason FROM room_blocks WHERE id = ?', [id]);
}

/** "Make available": removes a closure so the time can be booked again. */
async function remove(admin, id, { ip } = {}) {
  return db.tx(async (x) => {
    const row = await x.get('DELETE FROM room_blocks WHERE id = ? RETURNING id, room_id, date, start_time, end_time, reason', [id]);
    if (!row) throw new AppError(404, 'Closure not found');
    await audit({ userId: admin.id, action: 'room.unblock', entity: 'room', entityId: row.room_id,
      details: { block: row.id, date: row.date, start: row.start_time, end: row.end_time, reason: row.reason }, ip }, x);
    return row;
  });
}

module.exports = { blockClashes, onDate, list, create, remove };
