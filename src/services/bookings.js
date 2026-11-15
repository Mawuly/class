'use strict';
const db = require('../db');
const { booking: rules } = require('../config');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');
const { audit } = require('./audit');
const { notify } = require('./notifications');
const { blockClashes } = require('./roomBlocks');

const CATEGORIES = ['lecture', 'tutorial', 'lab', 'exam', 'meeting', 'study', 'event'];
const STUDENT_CATEGORIES = ['study', 'meeting', 'event'];
// Pending and approved bookings both hold their slot, so two requests can never overlap.
const HOLDING = "('pending', 'approved')";
const EXCLUSION_VIOLATION = '23P01'; // Postgres error code raised by the no-overlap constraints

const BOOKING_COLUMNS = `
  b.id, b.room_id, r.code AS room_code, r.name AS room_name, bl.code AS building_code,
  b.user_id, b.title, b.category, b.course_code, b.date, b.start_time, b.end_time,
  b.attendees, b.notes, b.status, b.series_id, b.decision_reason, b.created_at, b.checked_in_at, b.released_at,
  b.supervisor, b.checked_out_at`;
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
    `SELECT start_time, end_time FROM bookings WHERE room_id = ? AND date = ? AND status IN ${HOLDING}
     UNION ALL SELECT start_time, end_time FROM room_blocks WHERE room_id = ? AND date = ?`,
    [roomId, date, roomId, date],
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
    supervisor: str(input.supervisor, 120) || null,
    date: str(input.date, 10),
    start: str(input.start, 5),
    end: str(input.end, 5),
    // Optional on the public site: one person unless said otherwise.
    attendees: input.attendees == null || input.attendees === '' ? 1 : Number(input.attendees),
    notes: str(input.notes, 500) || null,
  };
}

/** Checks shared by single and weekly bookings: everything except the date and clashes. */
async function prepare(user, input) {
  const d = parseInput(input);
  if (!Number.isInteger(d.roomId)) throw new AppError(400, 'Choose a room');
  if (!d.title) throw new AppError(400, 'Give the booking a title');
  // Category is optional: study for students, lecture for staff.
  if (!d.category) d.category = user.role === 'student' ? 'study' : 'lecture';
  if (!CATEGORIES.includes(d.category)) throw new AppError(400, 'Choose a valid category');
  if (!Number.isInteger(d.attendees) || d.attendees < 1) throw new AppError(400, 'Attendees must be a whole number of at least 1');

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
  return { d, room, status: user.role === 'student' ? 'pending' : 'approved' };
}

async function create(user, input, { ip } = {}) {
  const { d, room, status } = await prepare(user, input);
  const slotError = t.validateSlot(d);
  if (slotError) throw new AppError(400, slotError);

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
    const closed = await blockClashes(x, d.roomId, d.date, d.start, d.end);
    if (closed.length) {
      const c = closed[0];
      throw new AppError(409, `${room.code} is unavailable ${c.start_time}–${c.end_time}: ${c.reason}`, {
        clash: 'unavailable',
        conflicts: closed,
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
      `INSERT INTO bookings (room_id, user_id, title, category, course_code, supervisor, date, start_time, end_time, attendees, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [d.roomId, user.id, d.title, d.category, d.courseCode, d.supervisor, d.date, d.start, d.end, d.attendees, d.notes, status],
    );
    await audit({ userId: user.id, action: 'booking.create', entity: 'booking', entityId: rows[0].id, details: { status }, ip }, x);
    return rows[0].id;
  }).catch((err) => {
    if (err.code === EXCLUSION_VIOLATION && err.constraint === 'bookings_reject_room_blocks') {
      throw new AppError(409, `${room.code} became unavailable at that time a moment ago. Please choose another time.`,
        { clash: 'unavailable', conflicts: [] });
    }
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

/* ---------- Weekly recurring bookings (staff only) ------------------------------------- */

const MAX_WEEKS = 16;

function seriesInput(user, input) {
  if (user.role === 'student') throw new AppError(403, 'Only lecturers and the timetable office can book weekly');
  const weeks = Number(input.weeks);
  if (!Number.isInteger(weeks) || weeks < 2 || weeks > MAX_WEEKS) {
    throw new AppError(400, `Repeat for 2 to ${MAX_WEEKS} weeks`);
  }
  const first = str(input.date, 10);
  if (!t.isValidDate(first)) throw new AppError(400, 'Date must be a valid date (YYYY-MM-DD)');
  return { weeks, dates: Array.from({ length: weeks }, (_, i) => t.addDays(first, 7 * i)) };
}

/**
 * Looks at every week: is the time allowed, is the room free, is the person free?
 * Returns one line per date: { date, ok, reason?, clash? }.
 */
async function planSeries(exec, user, d, room, dates) {
  const plan = [];
  for (const date of dates) {
    const slotError = t.validateSlot({ date, start: d.start, end: d.end });
    if (slotError) { plan.push({ date, ok: false, reason: slotError, clash: 'rules' }); continue; }
    const rc = await roomClashes(exec, d.roomId, date, d.start, d.end);
    if (rc.length) {
      const c = rc[0];
      plan.push({ date, ok: false, clash: 'room',
        reason: `${room.code} is taken ${c.start_time}–${c.end_time}${c.course_code ? ` by ${c.course_code}` : ''}` });
      continue;
    }
    const closed = await blockClashes(exec, d.roomId, date, d.start, d.end);
    if (closed.length) {
      const c = closed[0];
      plan.push({ date, ok: false, clash: 'unavailable', reason: `${room.code} is unavailable ${c.start_time}–${c.end_time}: ${c.reason}` });
      continue;
    }
    const uc = await userClashes(exec, user.id, date, d.start, d.end);
    if (uc.length) {
      const c = uc[0];
      plan.push({ date, ok: false, clash: 'user', reason: `You are booked in ${c.room_code} ${c.start_time}–${c.end_time}` });
      continue;
    }
    plan.push({ date, ok: true });
  }
  return plan;
}

/** Shows which weeks are free before anything is booked. */
async function previewSeries(user, input) {
  const { weeks, dates } = seriesInput(user, input);
  const { d, room } = await prepare(user, input);
  if (!t.isValidTime(d.start) || !t.isValidTime(d.end)) throw new AppError(400, 'Times must be in HH:MM format');
  return { room: room.code, weeks, start: d.start, end: d.end, dates: await planSeries(db, user, d, room, dates) };
}

/**
 * Books every free week in one transaction. If some weeks clash, nothing is booked unless
 * skipClashes is true, in which case only the free weeks are booked.
 */
async function createSeries(user, input, { ip } = {}) {
  const { dates } = seriesInput(user, input);
  const { d, room, status } = await prepare(user, input);
  try {
    return await db.tx(async (x) => {
      const plan = await planSeries(x, user, d, room, dates);
      const free = plan.filter((p) => p.ok);
      const blocked = plan.filter((p) => !p.ok);
      if (blocked.length && input.skipClashes !== true) {
        throw new AppError(409, `${blocked.length} of ${plan.length} weeks can't be booked. Skip them, or choose another time.`,
          { dates: plan });
      }
      if (!free.length) throw new AppError(409, 'None of these weeks are free at that time', { dates: plan });

      const series = await x.get(
        `INSERT INTO booking_series (user_id, room_id, weekday, start_time, end_time, first_date, last_date)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [user.id, d.roomId, new Date(`${free[0].date}T00:00:00Z`).getUTCDay(), d.start, d.end, free[0].date, free[free.length - 1].date],
      );
      for (const p of free) {
        await x.run(
          `INSERT INTO bookings (room_id, user_id, title, category, course_code, supervisor, date, start_time, end_time, attendees, notes, status, series_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [d.roomId, user.id, d.title, d.category, d.courseCode, d.supervisor, p.date, d.start, d.end, d.attendees, d.notes, status, series.id],
        );
      }
      await audit({ userId: user.id, action: 'series.create', entity: 'booking_series', entityId: series.id,
        details: { room: room.code, weeks: free.length, skipped: blocked.map((b) => b.date) }, ip }, x);
      return { seriesId: series.id, room: room.code, start: d.start, end: d.end, booked: free.map((p) => p.date), skipped: blocked };
    });
  } catch (err) {
    if (err.code === EXCLUSION_VIOLATION) {
      throw new AppError(409, 'One of these weeks was booked or closed a moment ago. Check the dates again.');
    }
    throw err;
  }
}

/** Cancels every week of a series that hasn't happened yet. */
async function cancelSeries(user, seriesId, { ip } = {}) {
  const series = await db.get('SELECT id, user_id, room_id FROM booking_series WHERE id = ?', [seriesId]);
  if (!series || (series.user_id !== user.id && user.role !== 'admin')) throw new AppError(404, 'Weekly booking not found');
  const today = t.localDate();
  return db.tx(async (x) => {
    const { rows } = await x.run(
      `UPDATE bookings SET status = 'cancelled', updated_at = now()
       WHERE series_id = ? AND status IN ${HOLDING} AND (date > ? OR (date = ? AND end_time > ?))
       RETURNING id, date`,
      [seriesId, today, today, t.localTime()],
    );
    if (!rows.length) throw new AppError(400, 'No weeks of this booking are still to come');
    await audit({ userId: user.id, action: 'series.cancel', entity: 'booking_series', entityId: seriesId,
      details: { cancelled: rows.length }, ip }, x);
    if (series.user_id !== user.id) {
      const code = (await x.get('SELECT code FROM rooms WHERE id = ?', [series.room_id])).code;
      await notify(series.user_id, `The timetable office cancelled the remaining ${rows.length} week${rows.length === 1 ? '' : 's'} `
        + `of your weekly booking in ${code}.`, x);
    }
    return { cancelled: rows.length };
  });
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

/**
 * Leaving early: after checking in and after the start, the owner ends the booking now. The end
 * moves to the current minute, so the rest of the slot is free straight away. It stays approved.
 */
async function checkOut(user, id, { ip } = {}) {
  const b = await getBooking(id);
  if (!b || b.user_id !== user.id) throw new AppError(404, 'Booking not found');
  if (b.status !== 'approved') throw new AppError(409, `This booking is ${b.status === 'pending' ? 'not approved yet' : b.status}`);
  if (!b.checked_in_at) throw new AppError(409, 'Check in first. You can check out after checking in.');
  if (b.checked_out_at) throw new AppError(409, 'You have already checked out');
  const now = new Date();
  const today = t.localDate(now);
  const time = t.localTime(now);
  if (b.date !== today || time <= b.start_time) throw new AppError(409, `You can check out once the booking has started (${b.start_time})`);
  if (time >= b.end_time) throw new AppError(409, 'This booking has already finished');
  await db.tx(async (x) => {
    await x.run(
      `UPDATE bookings SET end_time = ?, checked_out_at = ?, updated_at = ? WHERE id = ? AND checked_out_at IS NULL`,
      [time, now, now, id],
    );
    await audit({ userId: user.id, action: 'booking.check_out', entity: 'booking', entityId: id,
      details: { planned_end: b.end_time, ended: time }, ip }, x);
  });
  return getBooking(id);
}

const REQUESTER_COLUMNS = `u.name AS user_name, u.email AS user_email, u.role AS user_role,
  u.department AS user_department, u.index_number AS user_index_number, r.capacity AS room_capacity`;

function hasEnded(b, now = new Date()) {
  const today = t.localDate(now);
  return b.date < today || (b.date === today && b.end_time <= t.localTime(now));
}

/** The approval queue: oldest-first by when the room is needed, so urgent requests are on top. */
async function listByStatus(status = 'pending', { date } = {}) {
  if (date && !t.isValidDate(date)) throw new AppError(400, 'Date must be a valid date (YYYY-MM-DD)');
  const rows = await db.all(
    `SELECT ${BOOKING_COLUMNS}, ${REQUESTER_COLUMNS}
     FROM ${BOOKING_FROM} JOIN users u ON u.id = b.user_id
     WHERE b.status = ? ${date ? 'AND b.date = ?' : ''} ORDER BY b.date, b.start_time LIMIT 500`,
    date ? [status, date] : [status],
  );
  return rows.map((b) => ({ ...b, ended: hasEnded(b) }));
}

/** Recent approvals and rejections, newest first, with who decided. */
async function listDecided(limit = 100) {
  return db.all(
    `SELECT ${BOOKING_COLUMNS}, ${REQUESTER_COLUMNS}, d.name AS decided_by_name, b.updated_at AS decided_at
     FROM ${BOOKING_FROM} JOIN users u ON u.id = b.user_id JOIN users d ON d.id = b.decided_by
     WHERE b.status IN ('approved', 'rejected') ORDER BY b.updated_at DESC LIMIT ?`,
    [limit],
  );
}

/** What an admin needs to judge one request: the room's other bookings that day, the requester's other requests. */
async function requestContext(id) {
  const b = await getBooking(id);
  if (!b) throw new AppError(404, 'Booking not found');
  const sameRoom = await db.all(
    `SELECT id, title, course_code, start_time, end_time, status FROM bookings
     WHERE room_id = ? AND date = ? AND id <> ? AND status IN ${HOLDING} ORDER BY start_time`,
    [b.room_id, b.date, id],
  );
  const { pending } = await db.get(
    "SELECT count(*)::int AS pending FROM bookings WHERE user_id = ? AND status = 'pending' AND id <> ?",
    [b.user_id, id],
  );
  const { decided, rejected } = await db.get(
    `SELECT count(*)::int AS decided, count(*) FILTER (WHERE status = 'rejected')::int AS rejected
     FROM bookings WHERE user_id = ? AND decided_by IS NOT NULL`,
    [b.user_id],
  );
  return { sameRoom, requester: { otherPending: pending, decided, rejected } };
}

async function decide(admin, id, decision, reason, { ip } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new AppError(400, 'Invalid decision');
  const cleanReason = str(reason, 300) || null;
  const b = await getBooking(id);
  if (!b) throw new AppError(404, 'Booking not found');
  if (b.status !== 'pending') throw new AppError(409, `This booking is already ${b.status}`);
  if (decision === 'rejected' && (!cleanReason || cleanReason.length < 3)) {
    throw new AppError(400, 'Give a reason for the rejection, so the person knows why');
  }
  if (decision === 'approved' && hasEnded(b)) {
    throw new AppError(409, 'The time for this request has already passed, so it can only be rejected');
  }

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

module.exports = {
  CATEGORIES, STUDENT_CATEGORIES, MAX_WEEKS, create, previewSeries, createSeries, cancelSeries, listMine, cancel, listByStatus, listDecided, requestContext,
  decide, getBooking, suggestSlot, checkOut,
};
