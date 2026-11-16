'use strict';
const { test, before, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { db, agent, signedIn, resetDb, roomId } = require('./helpers');
const checkin = require('../src/services/checkin');
const { localDate, localTime, fromMinutes, toMinutes } = require('../src/utils/time');

before(resetDb);
after(() => db.pool.end());

// These tests place bookings around the real clock; skip them in the first and last hour of the day.
const minuteOfDay = toMinutes(localTime());
const skip = minuteOfDay < 90 || minuteOfDay > 22 * 60 ? 'too close to midnight' : false;

/** An approved booking starting `from` minutes from now (negative = already started). */
async function bookingAt(user, code, from, length = 60, { status = 'approved', approvedAgo = 120 } = {}) {
  const start = minuteOfDay + from;
  const row = await db.get(
    `INSERT INTO bookings (room_id, user_id, title, category, date, start_time, end_time, attendees, status, updated_at)
     VALUES (?, ?, 'Revision', 'study', ?, ?, ?, 4, ?, now() - make_interval(mins => ?)) RETURNING id`,
    [await roomId(code), user.id, localDate(), fromMinutes(start), fromMinutes(start + length), status, approvedAgo],
  );
  return row.id;
}
const doorCode = async (code) => (await db.get('SELECT door_code FROM rooms WHERE code = ?', [code])).door_code;
const status = async (id) => (await db.get('SELECT status, checked_in_at FROM bookings WHERE id = ?', [id]));

describe('door codes', () => {
  beforeEach(resetDb);

  test('every room gets its own six-character code, without look-alike characters', async () => {
    const rows = await db.all('SELECT door_code FROM rooms');
    assert.ok(rows.length > 5);
    assert.equal(new Set(rows.map((r) => r.door_code)).size, rows.length);
    for (const r of rows) assert.match(r.door_code, /^[A-HJKMNP-Z2-9]{6}$/);
  });

  test('the door page works without signing in, but shows times only', async () => {
    const owner = await signedIn('ama@campus.test', 'lecturer');
    await bookingAt(owner.user, 'LIB-S1', -5);
    const code = await doorCode('LIB-S1');
    const res = await agent().get(`/api/door/${code.toLowerCase().replace(/(...)/, '$1-')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.room.code, 'LIB-S1');
    assert.equal(res.body.signedIn, false);
    assert.equal(res.body.book, null);
    assert.equal(res.body.current?.title, undefined);
    assert.equal((await agent().get('/api/door/AAAAAA')).status, 404);
  }, { skip });

  test('admins can print signs and replace a code; the old one stops working', async () => {
    const admin = await signedIn('boss@campus.test');
    const id = await roomId('LIB-S1');
    const old = await doorCode('LIB-S1');
    const signs = await admin.get(`/api/admin/door-signs?room=${id}`);
    assert.equal(signs.status, 200);
    assert.match(signs.body.signs[0].url, new RegExp(`/door\\?c=${old}$`));
    const qr = await admin.raw.get(`/api/admin/rooms/${id}/door-qr.svg`).buffer(true)
      .parse((res, done) => { let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => done(null, text)); });
    assert.equal(qr.status, 200);
    assert.match(qr.headers['content-type'], /image\/svg\+xml/);
    assert.match(qr.body, /<svg/);
    const fresh = await admin.post(`/api/admin/rooms/${id}/door-code`);
    assert.notEqual(fresh.body.room.door_code, old);
    assert.equal((await agent().get(`/api/door/${old}`)).status, 404);
    const student = await signedIn('kofi@campus.test');
    assert.equal((await student.get('/api/admin/door-signs')).status, 403);
  });
});

describe('check-in', () => {
  beforeEach(resetDb);

  test('the owner checks in with the door code from 10 minutes before the start', async () => {
    const a = await signedIn('kofi@campus.test');
    const id = await bookingAt(a.user, 'LIB-S1', 8);
    const res = await a.post('/api/door/check-in').send({ code: await doorCode('LIB-S1'), via: 'qr' });
    assert.equal(res.status, 200);
    assert.equal(res.body.alreadyCheckedIn, false);
    assert.ok((await status(id)).checked_in_at);
    const again = await a.post('/api/door/check-in').send({ code: await doorCode('LIB-S1') });
    assert.equal(again.body.alreadyCheckedIn, true);
    const log = await db.get("SELECT details FROM audit_log WHERE action = 'booking.check_in'");
    assert.equal(log.details.via, 'qr');
  }, { skip });

  test('too early, the wrong room, or someone else\'s booking does not check in', async () => {
    const a = await signedIn('kofi@campus.test');
    await bookingAt(a.user, 'LIB-S1', 45);
    const early = await a.post('/api/door/check-in').send({ code: await doorCode('LIB-S1') });
    assert.equal(early.status, 400);
    assert.match(early.body.error, /You can check in from/);
    const wrong = await a.post('/api/door/check-in').send({ code: await doorCode('LIB-S2') });
    assert.match(wrong.body.error, /no booking in LIB-S2/);
    const b = await signedIn('esi@campus.test');
    const other = await b.post('/api/door/check-in').send({ code: await doorCode('LIB-S1') });
    assert.equal(other.status, 400);
    assert.equal((await agent().post('/api/door/check-in').send({ code: 'ABCDEF' })).status, 401);
  }, { skip });

  test('a pending request cannot be checked in', async () => {
    const a = await signedIn('kofi@campus.test');
    await bookingAt(a.user, 'LIB-S1', -2, 60, { status: 'pending' });
    const res = await a.post('/api/door/check-in').send({ code: await doorCode('LIB-S1') });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /hasn't been approved/);
  }, { skip });
});

describe('releasing no-shows', () => {
  beforeEach(resetDb);

  test('nobody checked in 15 minutes after the start: released, room free, owner told, logged', async () => {
    const a = await signedIn('kofi@campus.test');
    const b = await signedIn('esi@campus.test');
    const c = await signedIn('yaw@campus.test', 'lecturer');
    const late = await bookingAt(a.user, 'LIB-S1', -20);
    const inTime = await bookingAt(b.user, 'LIB-S2', -10, 30);
    const checked = await bookingAt(c.user, 'SCB-105', -40, 120);
    await db.run('UPDATE bookings SET checked_in_at = now() WHERE id = ?', [checked]);

    await a.get('/api/notifications'); // any request runs the release
    assert.equal((await status(late)).status, 'released');
    assert.equal((await status(inTime)).status, 'approved');
    assert.equal((await status(checked)).status, 'approved');

    const notes = (await a.get('/api/notifications')).body.notifications;
    assert.match(notes[0].message, /LIB-S1.*released because nobody checked in by/);
    const entry = await db.get("SELECT user_id, details FROM audit_log WHERE action = 'booking.release'");
    assert.equal(entry.user_id, null);

    // Too late to check in now, and the slot is free for someone else.
    const res = await a.post('/api/door/check-in').send({ code: await doorCode('LIB-S1') });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Too late/);
    const door = await a.get(`/api/door/${await doorCode('LIB-S1')}`);
    assert.equal(door.body.current, null);
    assert.equal(door.body.mine.state, 'released');
  }, { skip });

  test('a request approved after it started gets the full grace period from the approval', async () => {
    const a = await signedIn('kofi@campus.test');
    const id = await bookingAt(a.user, 'LIB-S1', -25, 90, { approvedAgo: 3 });
    await checkin.releaseNoShows();
    assert.equal((await status(id)).status, 'approved');
    await checkin.releaseNoShows(new Date(Date.now() + 13 * 60_000));
    assert.equal((await status(id)).status, 'released');
  }, { skip });

  test('the door page offers booking from the next half hour, up to the next booking', async () => {
    const owner = await signedIn('ama@campus.test', 'lecturer');
    const slot = Math.ceil(minuteOfDay / 30) * 30;
    // Only while rooms are open, with two hours left before closing (06:30–20:30 by default).
    const { open, close } = require('../src/config').booking;
    if (slot < toMinutes(open) || slot + 120 > toMinutes(close)) return;
    await db.run(
      `INSERT INTO bookings (room_id, user_id, title, category, date, start_time, end_time, attendees, status)
       VALUES (?, ?, 'Seminar', 'meeting', ?, ?, ?, 4, 'approved')`,
      [await roomId('LIB-S1'), owner.user.id, localDate(), fromMinutes(slot + 60), fromMinutes(slot + 120)],
    );
    const a = await signedIn('kofi@campus.test');
    const door = await a.get(`/api/door/${await doorCode('LIB-S1')}`);
    assert.equal(door.body.book.start, fromMinutes(slot));
    assert.deepEqual(door.body.book.ends, [fromMinutes(slot + 60)]); // whole hours, up to the next booking
    assert.equal(door.body.book.needsApproval, true);
    assert.equal(door.body.upcoming[0].title, 'Seminar');
  }, { skip });

  test('statistics count check-ins and releases', async () => {
    const admin = await signedIn('boss@campus.test');
    const a = await signedIn('kofi@campus.test');
    const b = await signedIn('esi@campus.test');
    await bookingAt(a.user, 'LIB-S1', -30);
    const ok = await bookingAt(b.user, 'LIB-S2', -30);
    await db.run('UPDATE bookings SET checked_in_at = now() WHERE id = ?', [ok]);
    const res = await admin.get(`/api/admin/stats?from=${localDate()}&to=${localDate()}`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      { total: res.body.attendance.total, checkedIn: res.body.attendance.checkedIn, released: res.body.attendance.released },
      { total: 2, checkedIn: 1, released: 1 },
    );
  }, { skip });
});

describe('campus rooms', () => {
  beforeEach(resetDb);

  test('a demo database switches to UCC rooms once, keeping the history of booked demo rooms', async () => {
    const { switchToCampus, CAMPUSES } = require('../src/db/campus');
    const a = await signedIn('ama@campus.test', 'lecturer');
    await db.run(
      `INSERT INTO bookings (room_id, user_id, title, category, date, start_time, end_time, attendees, status)
       VALUES (?, ?, 'Old lecture', 'lecture', current_date - 3, '08:00', '10:00', 50, 'approved')`,
      [await roomId('LT-1'), a.user.id],
    );
    const changed = await switchToCampus(db, 'ucc');
    assert.deepEqual(changed, { deleted: 15, retired: 1, kept: 0 });
    const old = await db.get("SELECT name, is_active FROM rooms WHERE code = 'DEMO-LT-1'");
    assert.deepEqual(old, { name: 'Lecture Theatre 1 (demo)', is_active: false });
    const lt1 = await db.get("SELECT bl.code FROM rooms r JOIN buildings bl ON bl.id = r.building_id WHERE r.code = 'LT-1'");
    assert.equal(lt1.code, 'LT'); // the Science Lecture Theatre's LT 1, not the demo one
    const { n } = await db.get("SELECT count(*)::int AS n FROM rooms WHERE is_active AND code NOT LIKE 'DEMO-%'");
    assert.equal(n, CAMPUSES.ucc.rooms.length);
    assert.equal((await db.get("SELECT count(*)::int AS n FROM buildings WHERE code IN ('SCB', 'NAB', 'LIB')")).n, 0);
    // Empty UCC buildings are there for the office to add rooms to.
    assert.ok(await db.get("SELECT 1 FROM buildings WHERE code = 'ELT'"));
    // Every room code passes the same check as the Rooms page.
    for (const [, code] of CAMPUSES.ucc.rooms) assert.match(code, /^[A-Z0-9][A-Z0-9-]*$/);
  });
});

describe('location check at check-in (flags, never blocks)', () => {
  beforeEach(resetDb);
  const geo = require('../src/utils/geo');

  test('distance and labels', () => {
    const building = { latitude: 5.1036, longitude: -1.2829, radius_m: 150 };
    assert.equal(geo.distanceM({ lat: 5.1036, lng: -1.2829 }, { lat: 5.1045, lng: -1.2829 }), 100);
    assert.equal(geo.label(building, { lat: 5.1045, lng: -1.2829, accuracy: 20 }).state, 'near');
    // 220 m away, but the phone is only sure to 80 m: 150 + 80 covers it.
    assert.equal(geo.label(building, { lat: 5.1056, lng: -1.2829, accuracy: 80 }).state, 'near');
    const far = geo.label(building, { lat: 5.1136, lng: -1.2829, accuracy: 15 });
    assert.deepEqual([far.state, far.distance], ['far', 1112]);
    assert.equal(geo.label(building, null).state, 'unknown');
    assert.equal(geo.label(building, { lat: 5.1, lng: -1.28, accuracy: 3000 }).state, 'unknown');
    assert.equal(geo.label(building, { lat: 'x', lng: 1 }).state, 'unknown');
    assert.equal(geo.label({ latitude: null, longitude: null, radius_m: 150 }, { lat: 5.1, lng: -1.28 }).state, 'unchecked');
  });

  test('the label and distance are saved, logged and shown in statistics; check-in always works', async () => {
    const admin = await signedIn('boss@campus.test');
    const lib = await db.get("SELECT id FROM buildings WHERE code = 'LIB'");
    const set = await admin.patch(`/api/admin/buildings/${lib.id}`).send({ latitude: '5.1036', longitude: '-1.2829', radiusM: 100 });
    assert.equal(set.status, 200);
    const people = await Promise.all(['ama', 'kofi', 'esi'].map((n) => signedIn(`${n}@campus.test`)));
    const rooms = ['LIB-S1', 'LIB-S2', 'LIB-S3'];
    for (let i = 0; i < 3; i++) await bookingAt(people[i].user, rooms[i], -5);
    const positions = [{ lat: 5.1037, lng: -1.2829, accuracy: 10 }, { lat: 5.1236, lng: -1.2829, accuracy: 10 }, undefined];
    const states = [];
    for (let i = 0; i < 3; i++) {
      const res = await people[i].post('/api/door/check-in').send({ code: await doorCode(rooms[i]), position: positions[i] });
      assert.equal(res.status, 200, 'never blocked');
      states.push(res.body.location.state);
    }
    assert.deepEqual(states, ['near', 'far', 'unknown']);
    const far = await db.get("SELECT checkin_location, checkin_distance_m FROM bookings WHERE checkin_location = 'far'");
    assert.equal(far.checkin_distance_m, 2224);
    const log = await db.get("SELECT details FROM audit_log WHERE action = 'booking.check_in' AND details->>'location' = 'far'");
    assert.equal(log.details.distance_m, 2224);
    const audit = await admin.get('/api/admin/audit?group=bookings');
    assert.ok(audit.body.entries.some((e) => /2\.2 km from the building/.test(e.detail)));
    const stats = await admin.get(`/api/admin/stats?from=${localDate()}&to=${localDate()}`);
    const loc = stats.body.attendance.location;
    assert.deepEqual([loc.near, loc.far, loc.unknown], [1, 1, 1]);
    assert.deepEqual(loc.flagged.map((f) => f.location).sort(), ['far', 'unknown']);
    // No coordinates of the person are stored anywhere.
    const cols = (await db.all("SELECT column_name FROM information_schema.columns WHERE table_name = 'bookings'")).map((c) => c.column_name);
    assert.ok(!cols.some((c) => /lat|lng|longitude/.test(c)));
  }, { skip });

  test('building locations must make sense', async () => {
    const admin = await signedIn('boss@campus.test');
    const lib = await db.get("SELECT id FROM buildings WHERE code = 'LIB'");
    assert.match((await admin.patch(`/api/admin/buildings/${lib.id}`).send({ latitude: '95', longitude: '1' })).body.error, /latitude/);
    assert.match((await admin.patch(`/api/admin/buildings/${lib.id}`).send({ radiusM: 5 })).body.error, /30 to 5000/);
    assert.equal((await admin.patch(`/api/admin/buildings/${lib.id}`).send({ latitude: '', longitude: '' })).status, 200);
  });
});

describe('"My bookings" shows check-in state', () => {
  beforeEach(resetDb);

  test('each booking says whether check-in is open, done, or not yet', async () => {
    const a = await signedIn('kofi@campus.test');
    const now = await bookingAt(a.user, 'LIB-S1', -5);
    const later = await bookingAt(a.user, 'LIB-S2', 120);
    let list = (await a.get('/api/bookings/mine')).body.bookings;
    const byId = (id) => list.find((b) => b.id === id);
    assert.equal(byId(now).check_in_state, 'open');
    assert.equal(byId(now).check_in_by, fromMinutes(minuteOfDay - 5 + 15));
    assert.equal(byId(later).check_in_state, 'early');
    assert.equal(byId(later).check_in_opens_at, fromMinutes(minuteOfDay + 120 - 10));
    await a.post('/api/door/check-in').send({ code: await doorCode('LIB-S1') });
    list = (await a.get('/api/bookings/mine')).body.bookings;
    assert.equal(byId(now).check_in_state, 'checked-in');
  }, { skip });
});

describe('campus-wide check-in area', () => {
  beforeEach(resetDb);

  test('UCC buildings get the campus area once; located or cleared buildings are left alone', async () => {
    const { applyCampusArea, UCC_AREA } = require('../src/db/campus');
    await db.run("DELETE FROM app_meta WHERE key = 'campus_area'");
    await db.run("UPDATE buildings SET latitude = 5.2, longitude = -1.3, radius_m = 120 WHERE code = 'LIB'");
    assert.equal(await applyCampusArea(db, 'demo'), 0, 'only for the UCC campus');
    const set = await applyCampusArea(db, 'ucc');
    assert.equal(set, (await db.get('SELECT count(*)::int AS n FROM buildings')).n - 1);
    const scb = await db.get("SELECT latitude, longitude, radius_m FROM buildings WHERE code = 'SCB'");
    assert.deepEqual(scb, { latitude: UCC_AREA.latitude, longitude: UCC_AREA.longitude, radius_m: 3000 });
    assert.equal((await db.get("SELECT radius_m FROM buildings WHERE code = 'LIB'")).radius_m, 120);
    // Once only: a building the office clears later stays cleared.
    await db.run("UPDATE buildings SET latitude = NULL, longitude = NULL WHERE code = 'SCB'");
    assert.equal(await applyCampusArea(db, 'ucc'), 0);
    assert.equal((await db.get("SELECT latitude FROM buildings WHERE code = 'SCB'")).latitude, null);
    // From the campus centre: ~1.5 km is inside, Cape Coast town (~5 km away) is flagged.
    const geo = require('../src/utils/geo');
    const area = { latitude: UCC_AREA.latitude, longitude: UCC_AREA.longitude, radius_m: 3000 };
    assert.equal(geo.label(area, { lat: 5.1295, lng: -1.2908, accuracy: 20 }).state, 'near');
    assert.equal(geo.label(area, { lat: 5.1053, lng: -1.2466, accuracy: 20 }).state, 'far');
  });
});
