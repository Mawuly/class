'use strict';
const { naturalCode } = require('../utils/sort');
const db = require('../db');
const { booking: rules } = require('../config');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');

const TYPES = ['lecture_hall', 'lab', 'seminar', 'study', 'meeting'];
const HOLDING = "('pending', 'approved')";

const ROOM_COLUMNS = `r.id, r.code, r.name, r.type, r.capacity, r.floor, r.facilities, r.bookable_by,
  r.building_id, bl.code AS building_code, bl.name AS building_name`;
const ROOM_FROM = 'rooms r JOIN buildings bl ON bl.id = r.building_id';

function shapeRoom(r) {
  return { ...r, facilities: Array.isArray(r.facilities) ? r.facilities : [] };
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
     ORDER BY r.capacity ASC, ${naturalCode('r.code')}`,
    [...args, date, end, start],
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
  return {
    date: day,
    open: rules.open,
    close: rules.close,
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
  return {
    room: { ...room, canBook: canBook(user, room) },
    from, to, open: rules.open, close: rules.close,
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
  const bookings = await db.all(
    `SELECT room_id, start_time, end_time FROM bookings
     WHERE date = ? AND status IN ${HOLDING} AND end_time > ? ORDER BY start_time`,
    [date, time],
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

module.exports = { TYPES, list, get, meta, available, daySchedule, week, now, canBook };
