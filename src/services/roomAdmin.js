'use strict';
// Managing buildings and rooms (admins only).
const db = require('../db');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');
const { naturalCode } = require('../utils/sort');
const { audit } = require('./audit');
const { notify } = require('./notifications');
const { TYPES } = require('./rooms');

const HOLDING = "('pending', 'approved')";
const CODE_RE = /^[A-Z0-9][A-Z0-9-]*$/;
const FACILITY_RE = /^[a-z0-9][a-z0-9_]*$/;
const UNIQUE_VIOLATION = '23505';

const s = (v) => (v == null ? '' : String(v).trim());

/** "Video conf" → "video_conf", so facilities stay consistent for filtering. */
function facilityKey(v) {
  return s(v).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function cleanBuilding(input, partial = false) {
  const out = {};
  if (!partial || input.code !== undefined) {
    out.code = s(input.code).toUpperCase();
    if (!CODE_RE.test(out.code) || out.code.length > 12) {
      throw new AppError(400, 'Building code: 1–12 letters, numbers or hyphens, e.g. SCB');
    }
  }
  if (!partial || input.name !== undefined) {
    out.name = s(input.name);
    if (out.name.length < 2 || out.name.length > 80) throw new AppError(400, 'Building name: 2–80 characters');
  }
  return out;
}

function cleanRoom(input, partial = false) {
  const out = {};
  const has = (k) => !partial || input[k] !== undefined;
  if (has('buildingId')) {
    out.building_id = Number(input.buildingId);
    if (!Number.isInteger(out.building_id) || out.building_id < 1) throw new AppError(400, 'Choose a building');
  }
  if (has('code')) {
    out.code = s(input.code).toUpperCase();
    if (!CODE_RE.test(out.code) || out.code.length > 20) {
      throw new AppError(400, 'Room code: 1–20 letters, numbers or hyphens, e.g. LT-2');
    }
  }
  if (has('name')) {
    out.name = s(input.name);
    if (out.name.length < 2 || out.name.length > 80) throw new AppError(400, 'Room name: 2–80 characters');
  }
  if (has('type')) {
    out.type = s(input.type);
    if (!TYPES.includes(out.type)) throw new AppError(400, 'Choose a room type');
  }
  if (has('capacity')) {
    out.capacity = Number(input.capacity);
    if (!Number.isInteger(out.capacity) || out.capacity < 1 || out.capacity > 2000) {
      throw new AppError(400, 'Seats must be a whole number from 1 to 2000');
    }
  }
  if (has('floor')) {
    out.floor = input.floor === '' || input.floor == null ? 0 : Number(input.floor);
    if (!Number.isInteger(out.floor) || out.floor < -5 || out.floor > 50) throw new AppError(400, 'Floor must be a whole number from -5 to 50');
  }
  if (has('facilities')) {
    const list = Array.isArray(input.facilities) ? input.facilities : [];
    const keys = [...new Set(list.map(facilityKey).filter(Boolean))];
    if (keys.length > 12) throw new AppError(400, 'At most 12 facilities');
    if (keys.some((k) => k.length > 30 || !FACILITY_RE.test(k))) throw new AppError(400, 'Facility names: up to 30 letters or numbers');
    out.facilities = JSON.stringify(keys.sort());
  }
  if (has('bookableBy')) {
    out.bookable_by = s(input.bookableBy) || (['lecture_hall', 'lab'].includes(out.type) ? 'staff' : 'all');
    if (!['staff', 'all'].includes(out.bookable_by)) throw new AppError(400, 'Choose who can book the room');
  }
  return out;
}

/** Turns duplicate-code errors from the database into a readable 409. */
function friendly(err, what, code) {
  if (err.code === UNIQUE_VIOLATION) throw new AppError(409, `There is already a ${what} with the code ${code}`);
  if (err.code === '23503') throw new AppError(400, 'That building does not exist');
  throw err;
}

function nowParts() {
  return { today: t.localDate(), now: t.localTime() };
}

/** Every building and room, including inactive rooms, with how much each is used. */
async function overview() {
  const { today, now } = nowParts();
  const buildings = await db.all(
    `SELECT bl.id, bl.code, bl.name, count(r.id)::int AS room_count
     FROM buildings bl LEFT JOIN rooms r ON r.building_id = bl.id
     GROUP BY bl.id ORDER BY bl.code`,
  );
  const rooms = await db.all(
    `SELECT r.id, r.building_id, bl.code AS building_code, bl.name AS building_name, r.code, r.name, r.type,
            r.capacity, r.floor, r.facilities, r.bookable_by, r.is_active, r.door_code,
            count(b.id)::int AS total_bookings,
            count(b.id) FILTER (WHERE b.status IN ${HOLDING}
              AND (b.date > ? OR (b.date = ? AND b.end_time > ?)))::int AS upcoming
     FROM rooms r JOIN buildings bl ON bl.id = r.building_id
     LEFT JOIN bookings b ON b.room_id = r.id
     GROUP BY r.id, bl.code, bl.name ORDER BY bl.code, ${naturalCode('r.code')}`,
    [today, today, now],
  );
  return { buildings, rooms, types: TYPES };
}

async function roomRow(id, exec = db) {
  const r = await exec.get('SELECT id, code, name, is_active FROM rooms WHERE id = ?', [id]);
  if (!r) throw new AppError(404, 'Room not found');
  return r;
}

/* ---------- Buildings ---------------------------------------------------------------- */

async function createBuilding(admin, input, { ip } = {}) {
  const b = cleanBuilding(input);
  const row = await db.get('INSERT INTO buildings (code, name) VALUES (?, ?) RETURNING id, code, name', [b.code, b.name])
    .catch((err) => friendly(err, 'building', b.code));
  await audit({ userId: admin.id, action: 'building.create', entity: 'building', entityId: row.id, details: b, ip });
  return row;
}

async function updateBuilding(admin, id, input, { ip } = {}) {
  const b = cleanBuilding(input, true);
  const keys = Object.keys(b);
  if (!keys.length) throw new AppError(400, 'Nothing to change');
  const row = await db.get(
    `UPDATE buildings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? RETURNING id, code, name`,
    [...keys.map((k) => b[k]), id],
  ).catch((err) => friendly(err, 'building', b.code));
  if (!row) throw new AppError(404, 'Building not found');
  await audit({ userId: admin.id, action: 'building.update', entity: 'building', entityId: id, details: b, ip });
  return row;
}

async function deleteBuilding(admin, id, { ip } = {}) {
  const b = await db.get('SELECT id, code FROM buildings WHERE id = ?', [id]);
  if (!b) throw new AppError(404, 'Building not found');
  const { n } = await db.get('SELECT count(*)::int AS n FROM rooms WHERE building_id = ?', [id]);
  if (n) throw new AppError(409, `${b.code} still has ${n} room${n === 1 ? '' : 's'}. Move or delete them first.`);
  await db.run('DELETE FROM buildings WHERE id = ?', [id]);
  await audit({ userId: admin.id, action: 'building.delete', entity: 'building', entityId: id, details: { code: b.code }, ip });
}

/* ---------- Rooms -------------------------------------------------------------------- */

async function createRoom(admin, input, { ip } = {}) {
  const r = cleanRoom(input);
  const row = await db.get(
    `INSERT INTO rooms (building_id, code, name, type, capacity, floor, facilities, bookable_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [r.building_id, r.code, r.name, r.type, r.capacity, r.floor, r.facilities, r.bookable_by],
  ).catch((err) => friendly(err, 'room', r.code));
  await audit({ userId: admin.id, action: 'room.create', entity: 'room', entityId: row.id, details: { code: r.code }, ip });
  return row;
}

/**
 * Updates a room. Deactivating a room that still has upcoming bookings needs
 * cancelUpcoming: true, which cancels them and tells each person who booked.
 */
async function updateRoom(admin, id, input, { ip } = {}) {
  const r = cleanRoom(input, true);
  const deactivate = input.isActive === false;
  const reactivate = input.isActive === true;
  const room = await roomRow(id);
  const { today, now } = nowParts();

  return db.tx(async (x) => {
    let cancelled = 0;
    if (deactivate && room.is_active) {
      const upcoming = await x.all(
        `SELECT b.id, b.user_id, b.date, b.start_time, b.end_time FROM bookings b
         WHERE b.room_id = ? AND b.status IN ${HOLDING} AND (b.date > ? OR (b.date = ? AND b.end_time > ?))
         ORDER BY b.date, b.start_time FOR UPDATE`,
        [id, today, today, now],
      );
      if (upcoming.length && input.cancelUpcoming !== true) {
        const one = upcoming.length === 1;
        throw new AppError(409, `${room.code} has ${upcoming.length} upcoming booking${one ? '' : 's'}. `
          + `Deactivating it cancels ${one ? 'it and tells the person' : 'them and tells the people'} who booked.`,
        { upcoming: upcoming.length, needsConfirm: true });
      }
      for (const b of upcoming) {
        await x.run("UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = ?", [b.id]);
        const day = new Date(`${b.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
        await notify(b.user_id, `Your booking for ${room.code} on ${day}, ${b.start_time}–${b.end_time} was cancelled `
          + 'because the room is no longer available. Please book another room.', x);
      }
      cancelled = upcoming.length;
    }

    const sets = Object.keys(r).map((k) => `${k} = ?`);
    const args = Object.values(r);
    if (deactivate) sets.push('is_active = false');
    if (reactivate) sets.push('is_active = true');
    if (!sets.length) throw new AppError(400, 'Nothing to change');
    await x.run(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);

    const action = deactivate ? 'room.deactivate' : reactivate ? 'room.reactivate' : 'room.update';
    await audit({ userId: admin.id, action, entity: 'room', entityId: id, details: { ...r, ...(cancelled ? { cancelled } : {}) }, ip }, x);
    return { id, cancelled };
  }).catch((err) => friendly(err, 'room', r.code));
}

/** Only rooms that were never booked can be deleted; others are deactivated so history stays intact. */
async function deleteRoom(admin, id, { ip } = {}) {
  const room = await roomRow(id);
  const { n } = await db.get('SELECT count(*)::int AS n FROM bookings WHERE room_id = ?', [id]);
  if (n) {
    // A room with history is deactivated instead, so its bookings keep pointing at it.
    const { today, now } = nowParts();
    const { upcoming } = await db.get(
      `SELECT count(*)::int AS upcoming FROM bookings WHERE room_id = ? AND status IN ${HOLDING}
         AND (date > ? OR (date = ? AND end_time > ?))`,
      [id, today, today, now],
    );
    if (upcoming) {
      throw new AppError(409, `${room.code} still has ${upcoming} upcoming booking${upcoming === 1 ? '' : 's'}. `
        + 'Deactivate it from its edit sheet: you will be asked to cancel them and the people who booked are told.');
    }
    if (room.is_active) {
      await db.tx(async (x) => {
        await x.run('UPDATE rooms SET is_active = false WHERE id = ?', [id]);
        await audit({ userId: admin.id, action: 'room.deactivate', entity: 'room', entityId: id, details: { instead_of: 'delete' }, ip }, x);
      });
    }
    return { deleted: false, deactivated: true };
  }
  await db.tx(async (x) => {
    await x.run('DELETE FROM booking_series WHERE room_id = ?', [id]);
    await x.run('DELETE FROM rooms WHERE id = ?', [id]);
    await audit({ userId: admin.id, action: 'room.delete', entity: 'room', entityId: id, details: { code: room.code }, ip }, x);
  });
  return { deleted: true, deactivated: false };
}

module.exports = {
  overview, createBuilding, updateBuilding, deleteBuilding, createRoom, updateRoom, deleteRoom, facilityKey,
};
