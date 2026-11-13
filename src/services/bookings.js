'use strict';
const db = require('../db');
const { booking: rules } = require('../config');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');
const { audit } = require('./audit');
const { notify } = require('./notifications');

const CATEGORIES = ['lecture', 'tutorial', 'lab', 'exam', 'meeting', 'study', 'event'];
const STUDENT_CATEGORIES = ['study', 'meeting', 'event'];
// Pending and approved bookings both hold their slot, so two requests can never overlap.
const HOLDING = "('pending', 'approved')";
const EXCLUSION_VIOLATION = '23P01'; // Postgres error code raised by the no-overlap constraints

const BOOKING_COLUMNS = `
  b.id, b.room_id, r.code AS room_code, r.name AS room_name, bl.code AS building_code,
  b.user_id, b.title, b.category, b.course_code, b.date, b.start_time, b.end_time,
  b.attendees, b.notes, b.status, b.series_id, b.decision_reason, b.created_at`;
const BOOKING_FROM = 'bookings b JOIN rooms r ON r.id = b.room_id JOIN buildings bl ON bl.id = r.building_id';

function str(v, max) {
  if (v == null) return '';
  return String(v).trim().slice(0, max);
}

function formatDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

function describe(b) {
  return `${b.room_code} on ${formatDate(b.date)}, ${b.start_time}–${b.end_time}`;
}

async function getBooking(id, exec = db) {
  return exec.get(`SELECT ${BOOKING_COLUMNS} FROM ${BOOKING_FROM} WHERE b.id = ?`, [id]);
}

async function roomClashes(exec, roomId, date, start, end) {
  return exec.all(
    `SELECT id, title, course_code, start_time, end_time, status FROM bookings
     WHERE room_id = ? AND date = ? AND status IN ${HOLDING} AND start_time < ? AND end_time > ?
     ORDER BY start_time`,
    [roomId, date, end, start],
  );
}

async function userClashes(exec, userId, date, start, end) {
  return exec.all(
    `SELECT b.id, b.title, b.start_time, b.end_time, r.code AS room_code
     FROM bookings b JOIN rooms r ON r.id = b.room_id
     WHERE b.user_id = ? AND b.date = ? AND b.status IN ${HOLDING} AND b.start_time < ? AND b.end_time > ?
     ORDER BY b.start_time`,
    [userId, date, end, start],
  );
}

/**
 * Nearest free slot of the same length in the same room on the same day,
 * or null when the room has no gap that long. Later slots win ties.
 */
async function suggestSlot(exec, roomId, date, start, end, now = new Date()) {
  const taken = await exec.all(
    `SELECT start_time, end_time FROM bookings WHERE room_id = ? AND date = ? AND status IN ${HOLDING}`,
    [roomId, date],
  );
  const length = t.toMinutes(end) - t.toMinutes(start);
  const wanted = t.toMinutes(start);
  let best = null;
  for (let s = t.toMinutes(rules.open); s + length <= t.toMinutes(rules.close); s += rules.slotMinutes) {
    const cs = t.fromMinutes(s);
    const ce = t.fromMinutes(s + length);
    if (t.validateSlot({ date, start: cs, end: ce }, now)) continue;
    if (taken.some((b) => t.overlaps(cs, ce, b.start_time, b.end_time))) continue;
    const distance = Math.abs(s - wanted);
    if (!best || distance < best.distance || (distance === best.distance && s > wanted)) {
      best = { start: cs, end: ce, distance };
    }
  }
  return best && { date, start: best.start, end: best.end };
}

function parseInput(input) {
  return {
    roomId: Number(input.roomId),
    title: str(input.title, 120),
    category: str(input.category, 20),
    courseCode: str(input.courseCode, 20).toUpperCase() || null,
    date: str(input.date, 10),
    start: str(input.start, 5),
    end: str(input.end, 5),
    attendees: Number(input.attendees),
    notes: str(input.notes, 500) || null,
  };
}

async function create(user, input, { ip } = {}) {
  const d = parseInput(input);
  if (!Number.isInteger(d.roomId)) throw new AppError(400, 'Choose a room');
  if (!d.title) throw new AppError(400, 'Give the booking a title');
  if (!CATEGORIES.includes(d.category)) throw new AppError(400, 'Choose a valid category');
  if (!Number.isInteger(d.attendees) || d.attendees < 1) throw new AppError(400, 'Attendees must be a whole number of at least 1');

  const slotError = t.validateSlot(d);
  if (slotError) throw new AppError(400, slotError);

  const room = await db.get('SELECT id, code, capacity, bookable_by FROM rooms WHERE id = ? AND is_active', [d.roomId]);
  if (!room) throw new AppError(404, 'Room not found');

  if (user.role === 'student') {
    if (room.bookable_by !== 'all') throw new AppError(403, `${room.code} can only be booked by staff`);
    if (!STUDENT_CATEGORIES.includes(d.category)) {
      throw new AppError(403, 'Students can book rooms for study, meetings or events only');
    }
  }
  if (d.attendees > room.capacity) {
    throw new AppError(400, `${room.code} holds ${room.capacity} people; you entered ${d.attendees}`);
  }

  const status = user.role === 'student' ? 'pending' : 'approved';

  const id = await db.tx(async (x) => {
    // Friendly checks first, so the user is told what is in the way and offered another slot.
    // The exclusion constraints in schema.sql still catch a request that slips in between.
    const roomConflicts = await roomClashes(x, d.roomId, d.date, d.start, d.end);
    if (roomConflicts.length) {
      const c = roomConflicts[0];
      throw new AppError(409, `${room.code} is taken ${c.start_time}–${c.end_time}${c.course_code ? ` by ${c.course_code}` : ''}`, {
        clash: 'room',
        conflicts: roomConflicts,
        suggestion: await suggestSlot(x, d.roomId, d.date, d.start, d.end),
      });
    }
    const ownConflicts = await userClashes(x, user.id, d.date, d.start, d.end);
    if (ownConflicts.length) {
      const c = ownConflicts[0];
      throw new AppError(409, `You are already booked in ${c.room_code} ${c.start_time}–${c.end_time}`, {
        clash: 'user',
        conflicts: ownConflicts,
      });
    }
    const { rows } = await x.run(
      `INSERT INTO bookings (room_id, user_id, title, category, course_code, date, start_time, end_time, attendees, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [d.roomId, user.id, d.title, d.category, d.courseCode, d.date, d.start, d.end, d.attendees, d.notes, status],
    );
    await audit({ userId: user.id, action: 'booking.create', entity: 'booking', entityId: rows[0].id, details: { status }, ip }, x);
    return rows[0].id;
  }).catch((err) => {
    if (err.code === EXCLUSION_VIOLATION) {
      const isRoom = err.constraint === 'bookings_no_room_overlap';
      throw new AppError(409, isRoom
        ? `${room.code} was booked by someone else a moment ago. Please choose another time.`
        : 'You already have a booking at that time', { clash: isRoom ? 'room' : 'user', conflicts: [] });
    }
    throw err;
  });

  return getBooking(id);
}

async function listMine(user, scope = 'upcoming') {
  const today = t.localDate();
  const now = t.localTime();
  const upcoming = scope !== 'past';
  const where = upcoming
    ? '(b.date > ? OR (b.date = ? AND b.end_time > ?))'
    : '(b.date < ? OR (b.date = ? AND b.end_time <= ?))';
  return db.all(
    `SELECT ${BOOKING_COLUMNS} FROM ${BOOKING_FROM} WHERE b.user_id = ? AND ${where}
     ORDER BY b.date ${upcoming ? 'ASC' : 'DESC'}, b.start_time ${upcoming ? 'ASC' : 'DESC'} LIMIT 200`,
    [user.id, today, today, now],
  );
}

async function cancel(user, id, { ip } = {}) {
  const b = await getBooking(id);
  if (!b || (b.user_id !== user.id && user.role !== 'admin')) throw new AppError(404, 'Booking not found');
  if (!['pending', 'approved'].includes(b.status)) throw new AppError(400, `This booking is already ${b.status}`);
  const today = t.localDate();
  if (b.date < today || (b.date === today && b.end_time <= t.localTime())) {
    throw new AppError(400, 'This booking has already finished');
  }
  await db.tx(async (x) => {
    await x.run("UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = ?", [id]);
    await audit({ userId: user.id, action: 'booking.cancel', entity: 'booking', entityId: id, ip }, x);
    if (b.user_id !== user.id) await notify(b.user_id, `Your booking for ${describe(b)} was cancelled by the timetable office.`, x);
  });
  return getBooking(id);
}

async function listByStatus(status = 'pending') {
  return db.all(
    `SELECT ${BOOKING_COLUMNS}, u.name AS user_name, u.email AS user_email, u.role AS user_role
     FROM ${BOOKING_FROM} JOIN users u ON u.id = b.user_id
     WHERE b.status = ? ORDER BY b.date, b.start_time LIMIT 500`,
    [status],
  );
}

async function decide(admin, id, decision, reason, { ip } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new AppError(400, 'Invalid decision');
  const cleanReason = str(reason, 300) || null;
  const b = await getBooking(id);
  if (!b) throw new AppError(404, 'Booking not found');
  if (b.status !== 'pending') throw new AppError(409, `This booking is already ${b.status}`);

  await db.tx(async (x) => {
    const { changes } = await x.run(
      `UPDATE bookings SET status = ?, decided_by = ?, decision_reason = ?, updated_at = now()
       WHERE id = ? AND status = 'pending'`,
      [decision, admin.id, cleanReason, id],
    );
    if (!changes) throw new AppError(409, 'This booking was decided by someone else');
    const verb = decision === 'approved' ? 'approved' : 'rejected';
    await notify(b.user_id, `Your booking for ${describe(b)} was ${verb}.${cleanReason ? ` Reason: ${cleanReason}` : ''}`, x);
    await audit({ userId: admin.id, action: `booking.${verb === 'approved' ? 'approve' : 'reject'}`, entity: 'booking', entityId: id, details: cleanReason ? { reason: cleanReason } : null, ip }, x);
  });
  return getBooking(id);
}

module.exports = { CATEGORIES, STUDENT_CATEGORIES, create, listMine, cancel, listByStatus, decide, getBooking, suggestSlot };
