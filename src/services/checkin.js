'use strict';
// Check-in at the door, and releasing rooms nobody turned up for.
//
// Every room has a six-character door code, printed on a sign by the door with a QR code that
// opens /door?c=CODE. Scanning the QR code or typing the code proves you are at the room, so
// you can check in to your booking. An approved booking nobody checks in to by
// start + grace minutes is released: its slot frees up and the person is told why.
const db = require('../db');
const config = require('../config');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');
const { audit } = require('./audit');
const { notify } = require('./notifications');
const { canBook } = require('./rooms');
const geo = require('../utils/geo');

const rules = config.booking;
const HOLDING = "('pending', 'approved')";
const minutesAgo = (now, n) => new Date(now.getTime() - n * 60_000);

/** "k7p 2qx", "K7P-2QX" → "K7P2QX"; null when it can't be a door code. */
function normaliseCode(raw) {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

const dayLabel = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
});

/**
 * Releases approved bookings that started more than the grace period ago with nobody checked in.
 * A booking approved after it started gets the full grace period from its approval. Safe to run
 * from several servers at once: a row is only released by whichever update reaches it first.
 */
async function releaseNoShows(now = new Date()) {
  if (!rules.releaseNoShows) return [];
  const graceAgo = minutesAgo(now, rules.checkInGraceMinutes);
  const today = t.localDate(now);
  // Bookings start on the half hour after 07:00, so the cutoff never crosses midnight.
  const cutoff = t.localDate(graceAgo) === today ? t.localTime(graceAgo) : '00:00';
  return db.tx(async (x) => {
    const released = await x.all(
      `UPDATE bookings b SET status = 'released', released_at = ?, updated_at = ?
       FROM rooms r
       WHERE r.id = b.room_id AND b.status = 'approved' AND b.checked_in_at IS NULL
         AND b.date = ? AND b.start_time <= ? AND b.end_time > ? AND b.updated_at <= ?
       RETURNING b.id, b.user_id, b.date, b.start_time, b.end_time, r.code AS room_code`,
      [now, now, today, cutoff, t.localTime(now), graceAgo],
    );
    for (const b of released) {
      const deadline = t.fromMinutes(t.toMinutes(b.start_time) + rules.checkInGraceMinutes);
      await notify(b.user_id, `Your booking for ${b.room_code} on ${dayLabel(b.date)}, ${b.start_time}–${b.end_time} `
        + `was released because nobody checked in by ${deadline}. The room is free for others now.`, x);
      await audit({ action: 'booking.release', entity: 'booking', entityId: b.id, details: { by: deadline } }, x);
    }
    return released;
  });
}

// Every API request runs the release first, so whatever a page shows is already up to date.
// One server checks at most every 20 seconds; tests check every time.
let lastRun = 0;
async function releaseIfDue() {
  const at = Date.now();
  if (!config.isTest && at - lastRun < 20_000) return;
  lastRun = at;
  await releaseNoShows();
}

/** Where a booking stands with check-in, for the dashboard and the door page. */
function checkInState(b, now = new Date()) {
  const today = t.localDate(now);
  const time = t.toMinutes(t.localTime(now));
  const start = t.toMinutes(b.start_time);
  const opensAt = t.fromMinutes(start - rules.checkInEarlyMinutes);
  const deadline = t.fromMinutes(start + rules.checkInGraceMinutes);
  const base = { opensAt, deadline, checkedInAt: b.checked_in_at || null };
  if (b.status === 'released') return { ...base, state: 'released' };
  if (b.checked_in_at) return { ...base, state: 'checked-in' };
  if (b.status !== 'approved') return { ...base, state: 'not-approved' };
  if (b.date > today || (b.date === today && time < start - rules.checkInEarlyMinutes)) return { ...base, state: 'early' };
  if (b.date < today || time >= t.toMinutes(b.end_time)) return { ...base, state: 'ended' };
  return { ...base, state: 'open' };
}

async function roomByCode(raw) {
  const code = normaliseCode(raw);
  const room = code && await db.get(
    `SELECT r.id, r.code, r.name, r.type, r.capacity, r.floor, r.facilities, r.bookable_by, r.door_code,
            bl.code AS building_code, bl.name AS building_name, bl.latitude, bl.longitude, bl.radius_m
     FROM rooms r JOIN buildings bl ON bl.id = r.building_id
     WHERE r.door_code = ? AND r.is_active`,
    [code],
  );
  if (!room) throw new AppError(404, "That code doesn't match any room. Check the sign on the door.");
  return room;
}

/**
 * Checks the signed-in person in to their booking in the room whose door code they gave.
 * Works from 10 minutes before the start until the grace period ends.
 */
async function checkIn(user, rawCode, { via = 'code', ip, position = null } = {}) {
  const now = new Date();
  const room = await roomByCode(rawCode);
  await releaseNoShows(now);
  const today = t.localDate(now);
  const time = t.localTime(now);
  const early = t.localTime(new Date(now.getTime() + rules.checkInEarlyMinutes * 60_000));
  const rows = await db.all(
    `SELECT id, title, date, start_time, end_time, status, checked_in_at FROM bookings
     WHERE user_id = ? AND room_id = ? AND date = ? AND end_time > ? AND status IN ('pending', 'approved', 'released')
     ORDER BY start_time`,
    [user.id, room.id, today, time],
  );
  const b = rows.find((r) => r.start_time <= early);
  if (!b) {
    const later = rows.find((r) => r.status !== 'released');
    throw new AppError(400, later
      ? `Your booking in ${room.code} starts at ${later.start_time}. You can check in from ${checkInState(later, now).opensAt}.`
      : `You have no booking in ${room.code} right now.`);
  }
  const s = checkInState(b, now);
  if (s.state === 'released') {
    throw new AppError(409, `Too late: your booking in ${room.code} was released because nobody checked in by ${s.deadline}.`);
  }
  if (s.state === 'not-approved') {
    throw new AppError(409, `Your request for ${room.code} at ${b.start_time} hasn't been approved yet.`);
  }
  if (s.state === 'checked-in') return { booking: { ...b, room_code: room.code }, alreadyCheckedIn: true };

  // Where the phone was, compared with the building. Only labels the check-in; never blocks it.
  const where = geo.label(room, position);

  const updated = await db.tx(async (x) => {
    const row = await x.get(
      `UPDATE bookings SET checked_in_at = ?, checkin_location = ?, checkin_distance_m = ?, checkin_accuracy_m = ?
       WHERE id = ? AND status = 'approved' AND checked_in_at IS NULL
       RETURNING id, title, date, start_time, end_time, status, checked_in_at, checkin_location, checkin_distance_m`,
      [now, where.state, where.distance, where.accuracy, b.id],
    );
    if (row) {
      await audit({ userId: user.id, action: 'booking.check_in', entity: 'booking', entityId: b.id,
        details: { via, location: where.state, ...(where.distance != null ? { distance_m: where.distance } : {}) }, ip }, x);
    }
    return row;
  });
  if (!updated) throw new AppError(409, 'This booking changed while you were checking in. Please try again.');
  return { booking: { ...updated, room_code: room.code }, alreadyCheckedIn: false, location: { state: where.state, distance: where.distance } };
}

/**
 * What the sign on a door shows: the room, whether it is in use, what is next today, your own
 * booking there, and how long you could book it for from the next half hour. Without a
 * sign-in it shows times only, like the "Campus Now" page.
 */
async function door(rawCode, user) {
  const now = new Date();
  const room = await roomByCode(rawCode);
  await releaseNoShows(now);
  const date = t.localDate(now);
  const time = t.localTime(now);
  const isOpen = time >= rules.open && time < rules.close;
  const rows = await db.all(
    `SELECT id, user_id, title, course_code, category, start_time, end_time, status, checked_in_at FROM bookings
     WHERE room_id = ? AND date = ? AND end_time > ? AND status IN ${HOLDING} ORDER BY start_time`,
    [room.id, date, time],
  );
  const shape = (b) => (b && {
    start: b.start_time,
    end: b.end_time,
    status: b.status,
    checkedIn: Boolean(b.checked_in_at),
    mine: Boolean(user && b.user_id === user.id),
    ...(user ? { title: b.title, courseCode: b.course_code } : {}),
    ...(b.status === 'approved' && !b.checked_in_at ? { checkInBy: checkInState({ ...b, date }, now).deadline } : {}),
  });
  const current = rows.find((b) => b.start_time <= time);
  const blocks = await db.all(
    'SELECT start_time, end_time, reason FROM room_blocks WHERE room_id = ? AND date = ? AND end_time > ? ORDER BY start_time',
    [room.id, date, time],
  );
  const closedNow = blocks.find((b) => b.start_time <= time);

  let mine = null;
  if (user) {
    const own = await db.get(
      `SELECT id, title, date, start_time, end_time, status, checked_in_at FROM bookings
       WHERE user_id = ? AND room_id = ? AND date = ? AND end_time > ? AND status IN ('pending', 'approved', 'released')
       ORDER BY start_time LIMIT 1`,
      [user.id, room.id, date, time],
    );
    if (own) mine = { id: own.id, title: own.title, start: own.start_time, end: own.end_time, status: own.status, ...checkInState(own, now) };
  }

  // Booking from the door starts at the next half hour (bookings can't start in the past).
  let book = null;
  const slot = rules.slotMinutes;
  const startMin = Math.ceil(t.toMinutes(time) / slot) * slot;
  const start = t.fromMinutes(startMin);
  if (user && canBook(user, room) && start >= rules.open && start < rules.close) {
    const nextTaken = [...rows, ...blocks].filter((b) => b.end_time > start).sort((a, b) => (a.start_time < b.start_time ? -1 : 1))[0];
    const blocked = nextTaken && nextTaken.start_time <= start;
    if (!blocked) {
      const limit = Math.min(
        t.toMinutes(nextTaken ? nextTaken.start_time : rules.close),
        t.toMinutes(rules.close),
        startMin + rules.maxHours * 60,
      );
      const ends = [];
      // Bookings last whole hours.
      for (let e = startMin + 60; e <= limit && ends.length < 8; e += 60) ends.push(t.fromMinutes(e));
      if (ends.length) book = { date, start, ends, needsApproval: user.role === 'student' };
    }
  }

  return {
    room: {
      id: room.id, code: room.code, name: room.name, type: room.type, capacity: room.capacity, floor: room.floor,
      facilities: Array.isArray(room.facilities) ? room.facilities : [],
      buildingCode: room.building_code, buildingName: room.building_name,
      directions: geo.directionsUrl({ name: room.building_name, latitude: room.latitude, longitude: room.longitude, radius_m: room.radius_m }),
    },
    date, time, isOpen, open: rules.open, close: rules.close,
    current: shape(current) || null,
    closed: closedNow ? { start: closedNow.start_time, end: closedNow.end_time, reason: closedNow.reason } : null,
    closures: blocks.filter((b) => b !== closedNow).map((b) => ({ start: b.start_time, end: b.end_time, reason: b.reason })),
    upcoming: rows.filter((b) => b !== current).slice(0, 5).map(shape),
    mine,
    book,
    signedIn: Boolean(user),
    checkIn: { earlyMinutes: rules.checkInEarlyMinutes, graceMinutes: rules.checkInGraceMinutes, release: rules.releaseNoShows },
  };
}

/** A new door code for one room, when a sign was lost or photographed. The old code stops working. */
async function newDoorCode(admin, roomId, { ip } = {}) {
  const row = await db.tx(async (x) => {
    const r = await x.get('UPDATE rooms SET door_code = new_door_code() WHERE id = ? RETURNING id, code, door_code', [roomId]);
    if (!r) throw new AppError(404, 'Room not found');
    await audit({ userId: admin.id, action: 'room.new_door_code', entity: 'room', entityId: r.id, ip }, x);
    return r;
  });
  return row;
}

module.exports = { normaliseCode, releaseNoShows, releaseIfDue, checkInState, checkIn, door, newDoorCode, roomByCode };
