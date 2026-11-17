'use strict';
const { naturalCode } = require('../utils/sort');
const db = require('../db');
const { booking: rules } = require('../config');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');
const { directionsUrl } = require('../utils/geo');

const TYPES = ['lecture_hall', 'lab', 'seminar', 'study', 'meeting'];
const HOLDING = "('pending', 'approved')";

const ROOM_COLUMNS = `r.id, r.code, r.name, r.type, r.capacity, r.floor, r.facilities, r.bookable_by, r.extended_hours,
  r.building_id, bl.code AS building_code, bl.name AS building_name,
  bl.latitude AS building_latitude, bl.longitude AS building_longitude, bl.radius_m AS building_radius_m`;
const ROOM_FROM = 'rooms r JOIN buildings bl ON bl.id = r.building_id';

/** A room as the API returns it: facilities as a list, directions instead of raw coordinates. */
function shapeRoom(r) {
  const { building_latitude: latitude, building_longitude: longitude, building_radius_m: radius, ...rest } = r;
  return {
    ...rest,
    facilities: Array.isArray(r.facilities) ? r.facilities : [],
    directions: directionsUrl({ name: r.building_name, latitude, longitude, radius_m: radius }),
  };
}

function parseId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new AppError(404, 'Room not found');
  return n;
}

function canBook(user, room) {
  return room.bookable_by === 'all' || (user && user.role !== 'student');
}

async function list({ buildingId, type } = {}) {
  const where = ['r.is_active'];
  const args = [];
  if (buildingId) { where.push('r.building_id = ?'); args.push(Number(buildingId)); }
  if (type) { where.push('r.type = ?'); args.push(type); }
  const rows = await db.all(`SELECT ${ROOM_COLUMNS} FROM ${ROOM_FROM} WHERE ${where.join(' AND ')} ORDER BY bl.code, ${naturalCode('r.code')}`, args);
  return rows.map(shapeRoom);
}

async function get(id) {
  const r = await db.get(`SELECT ${ROOM_COLUMNS} FROM ${ROOM_FROM} WHERE r.id = ? AND r.is_active`, [parseId(id)]);
  if (!r) throw new AppError(404, 'Room not found');
  return shapeRoom(r);
}

async function meta() {
  const buildings = await db.all('SELECT id, code, name FROM buildings ORDER BY code');
  const rows = await db.all('SELECT facilities FROM rooms WHERE is_active');
  const facilities = [...new Set(rows.flatMap((r) => shapeRoom(r).facilities))].sort();
  return { buildings, types: TYPES, facilities, rules };
}

/**
 * Free-room finder. Rooms the user may book that have no holding booking in the slot,
 * smallest suitable room first so big halls are not used up by small groups.
 */
async function available(user, q) {
  const date = String(q.date || '');
  const start = String(q.start || '');
  const end = String(q.end || '');
  const slotError = t.validateSlot({ date, start, end });
  if (slotError) throw new AppError(400, slotError);

  const minCapacity = Math.max(1, Number(q.minCapacity) || 1);
  const where = ['r.is_active', 'r.capacity >= ?'];
  const args = [minCapacity];
  if (q.type) {
    if (!TYPES.includes(q.type)) throw new AppError(400, 'Unknown room type');
    where.push('r.type = ?'); args.push(q.type);
  }
  if (q.buildingId) { where.push('r.building_id = ?'); args.push(Number(q.buildingId)); }
  if (user.role === 'student') where.push("r.bookable_by = 'all'");

  const rows = await db.all(
    `SELECT ${ROOM_COLUMNS} FROM ${ROOM_FROM}
     WHERE ${where.join(' AND ')}
       AND NOT EXISTS (
         SELECT 1 FROM bookings b WHERE b.room_id = r.id AND b.date = ? AND b.status IN ${HOLDING}
           AND b.start_time < ? AND b.end_time > ?)
       AND NOT EXISTS (
         SELECT 1 FROM room_blocks rb WHERE rb.room_id = r.id AND rb.date = ?
           AND rb.start_time < ? AND rb.end_time > ?)
     ORDER BY r.capacity ASC, ${naturalCode('r.code')}`,
    [...args, date, end, start, date, end, start],
  );

  const wanted = String(q.facilities || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rooms = rows.map(shapeRoom).filter((r) => wanted.every((f) => r.facilities.includes(f)));
  return rooms.map((r, i) => ({ ...r, bestFit: i === 0 }));
}

/** Every room in a building (or all rooms) against one day's bookings: the day board. */
async function daySchedule(user, { date, buildingId }) {
  const day = date || t.localDate();
  if (!t.isValidDate(day)) throw new AppError(400, 'Date must be a valid date (YYYY-MM-DD)');
  const rooms = await list({ buildingId });
  const args = [day];
  let filter = '';
  if (buildingId) { filter = 'AND r.building_id = ?'; args.push(Number(buildingId)); }
  const bookings = await db.all(
    `SELECT b.id, b.room_id, b.user_id, b.title, b.category, b.course_code, b.start_time, b.end_time, b.status
     FROM bookings b JOIN rooms r ON r.id = b.room_id
     WHERE b.date = ? AND b.status IN ${HOLDING} ${filter} ORDER BY b.start_time`,
    args,
  );
  const blocks = await db.all(
    `SELECT rb.id, rb.room_id, rb.start_time, rb.end_time, rb.reason
     FROM room_blocks rb JOIN rooms r ON r.id = rb.room_id
     WHERE rb.date = ? ${filter} ORDER BY rb.start_time`,
    args,
  );
  return {
    date: day,
    open: rules.open,
    close: rules.close,
    blocks,
    rooms: rooms.map((r) => ({ ...r, canBook: canBook(user, r) })),
    bookings: bookings.map(({ user_id: uid, ...b }) => ({ ...b, mine: uid === user.id })),
  };
}

/** Seven days of one room's bookings, starting from the Monday of the given date's week. */
async function week(user, id, { date }) {
  const room = await get(id);
  const ref = date || t.localDate();
  if (!t.isValidDate(ref)) throw new AppError(400, 'Date must be a valid date (YYYY-MM-DD)');
  const weekday = (new Date(`${ref}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const from = t.addDays(ref, -weekday);
  const to = t.addDays(from, 6);
  const bookings = await db.all(
    `SELECT id, user_id, title, category, course_code, date, start_time, end_time, status FROM bookings
     WHERE room_id = ? AND date BETWEEN ? AND ? AND status IN ${HOLDING} ORDER BY date, start_time`,
    [room.id, from, to],
  );
  const blocks = await db.all(
    `SELECT id, date, start_time, end_time, reason FROM room_blocks
     WHERE room_id = ? AND date BETWEEN ? AND ? ORDER BY date, start_time`,
    [room.id, from, to],
  );
  return {
    room: { ...room, canBook: canBook(user, room) },
    from, to, open: rules.open, close: rules.close, blocks,
    bookings: bookings.map(({ user_id: uid, ...b }) => ({ ...b, mine: uid === user.id })),
  };
}

/**
 * Public snapshot for the "Campus Now" landing page: how many rooms are free this minute,
 * plus short lines for the ticker. Shows room codes and times only, never who booked.
 */
async function now(at = new Date()) {
  const date = t.localDate(at);
  const time = t.localTime(at);
  const rooms = await db.all(`SELECT r.id, r.code, r.name FROM rooms r WHERE r.is_active ORDER BY ${naturalCode('r.code')}`);
  const isOpen = time >= rules.open && time < rules.close;
  // Closures count like bookings: the room is not free while it is closed.
  const bookings = await db.all(
    `SELECT room_id, start_time, end_time FROM bookings
     WHERE date = ? AND status IN ${HOLDING} AND end_time > ?
     UNION ALL
     SELECT room_id, start_time, end_time FROM room_blocks WHERE date = ? AND end_time > ?
     ORDER BY start_time`,
    [date, time, date, time],
  );

  const byRoom = new Map(rooms.map((r) => [r.id, []]));
  for (const b of bookings) byRoom.get(b.room_id)?.push(b);

  let free = 0;
  const ticker = [];
  for (const r of rooms) {
    const list = byRoom.get(r.id) || [];
    const current = list.find((b) => b.start_time <= time && b.end_time > time);
    if (!isOpen) continue;
    if (current) {
      // Walk forward through back-to-back bookings to find when the room really frees up.
      let freeAt = current.end_time;
      for (const b of list) if (b.start_time <= freeAt && b.end_time > freeAt) freeAt = b.end_time;
      if (freeAt < rules.close) ticker.push({ code: r.code, text: `frees up at ${freeAt}`, sort: 1 });
    } else {
      free += 1;
      const next = list[0];
      ticker.push(next
        ? { code: r.code, text: `free until ${next.start_time}`, sort: 0 }
        : { code: r.code, text: 'free now', sort: 2 });
    }
  }
  ticker.sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code, 'en', { numeric: true }));

  return {
    date,
    time,
    isOpen,
    open: rules.open,
    close: rules.close,
    total: rooms.length,
    free: isOpen ? free : 0,
    ticker: ticker.slice(0, 14).map(({ code, text }) => ({ code, text })),
  };
}

/**
 * Free whole-hour periods in [from, close), given the taken ranges. Periods start on the
 * half hour (like bookings) and are at least an hour long.
 */
function freePeriods(taken, from, close) {
  const slot = rules.slotMinutes;
  const periods = [];
  let cursor = Math.ceil(t.toMinutes(from) / slot) * slot;
  const end = t.toMinutes(close);
  const busy = taken.map((b) => [t.toMinutes(b.start_time), t.toMinutes(b.end_time)]).sort((a, b) => a[0] - b[0]);
  for (const [s, e] of [...busy, [end, end]]) {
    const gapEnd = Math.min(s, end);
    if (gapEnd - cursor >= 60) periods.push({ start: t.fromMinutes(cursor), end: t.fromMinutes(gapEnd) });
    cursor = Math.max(cursor, Math.ceil(e / slot) * slot);
    if (cursor >= end) break;
  }
  return periods;
}

/**
 * Free periods in minutes from `from` to `to` (both may pass 24:00), at least an hour, starting on
 * the half hour. `busy` is a list of [start, end] in the same minutes.
 */
function freeMinutes(busy, from, to) {
  const slot = rules.slotMinutes;
  const out = [];
  let cursor = Math.ceil(from / slot) * slot;
  for (const [s, e] of [...busy].sort((a, b) => a[0] - b[0]).concat([[to, to]])) {
    const gapEnd = Math.min(s, to);
    if (gapEnd - cursor >= 60) out.push([cursor, gapEnd]);
    cursor = Math.max(cursor, Math.ceil(e / slot) * slot);
    if (cursor >= to) break;
  }
  return out;
}
const asTime = (m) => t.fromMinutes(m % (24 * 60));

/**
 * Public list for the site before sign-in: every active room with its free periods on a date
 * (from now, if the date is today). Never shows booking titles or who booked.
 */
async function publicRooms({ date } = {}, at = new Date()) {
  const today = t.localDate(at);
  const day = date ? String(date) : today;
  if (!t.isValidDate(day)) throw new AppError(400, 'Date must be a valid date (YYYY-MM-DD)');
  if (day < today) throw new AppError(400, 'Choose today or a later date');
  if (t.daysBetween(today, day) > rules.maxDaysAhead) throw new AppError(400, `Rooms can be booked at most ${rules.maxDaysAhead} days ahead`);
  const rooms = await db.all(`SELECT ${ROOM_COLUMNS} FROM ${ROOM_FROM} WHERE r.is_active ORDER BY bl.code, ${naturalCode('r.code')}`);
  // Event rooms run into the next morning, so the next date's early hours count for them too.
  const next = t.addDays(day, 1);
  const taken = await db.all(
    `SELECT room_id, date, start_time, end_time FROM bookings WHERE date IN (?, ?) AND status IN ${HOLDING}
     UNION ALL SELECT room_id, date, start_time, end_time FROM room_blocks WHERE date IN (?, ?)`,
    [day, next, day, next],
  );
  const byRoom = new Map();
  for (const b of taken) {
    const shift = b.date === day ? 0 : 24 * 60;
    byRoom.set(b.room_id, [...(byRoom.get(b.room_id) || []), [t.toMinutes(b.start_time) + shift, t.toMinutes(b.end_time) + shift]]);
  }
  const now = t.localTime(at);
  const from = day === today && now > rules.open ? now : rules.open;
  return {
    date: day,
    open: rules.open,
    close: rules.close,
    maxHours: rules.maxHours,
    // Whether student requests wait for the timetable office (the page words its buttons from this).
    studentsNeedApproval: rules.studentApproval === 'manual',
    // Event rooms: bookable until eventClose the next morning, for up to eventMaxHours.
    eventClose: rules.eventClose,
    eventMaxHours: rules.eventMaxHours,
    rooms: rooms.map((r) => {
      const busy = byRoom.get(r.id) || [];
      const end = r.extended_hours ? 24 * 60 + t.toMinutes(rules.eventClose) : t.toMinutes(rules.close);
      // A period that runs past midnight says so (endsNextDay); one starting after it, startsNextDay.
      const periods = freeMinutes(busy.filter(([s]) => s < end), t.toMinutes(from), end).map(([s, e]) => ({
        start: asTime(s), end: asTime(e),
        ...(s >= 24 * 60 ? { startsNextDay: true } : {}), ...(e >= 24 * 60 ? { endsNextDay: true } : {}),
      }));
      const { building_id: _b, ...room } = shapeRoom(r);
      // `free` is what the public site reads; `firstFree` is the name in the implementation guide.
      return { ...room, freePeriods: periods, firstFree: periods[0] || null, free: periods[0] || null };
    }),
  };
}

module.exports = { TYPES, list, get, meta, available, daySchedule, week, now, canBook, publicRooms, freePeriods };
