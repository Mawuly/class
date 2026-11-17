'use strict';
// The features from the Supabase implementation guide: closures, the booking window, whole-hour
// bookings, supervisor, check-out, the public room list and the API paths it names.
const { test, before, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { db, agent, signedIn, resetDb, roomId, tomorrow } = require('./helpers');
const { localDate, localTime, fromMinutes, toMinutes, addDays } = require('../src/utils/time');

before(resetDb);
after(() => db.pool.end());

const book = (a, code, date, start, end, extra = {}) => roomId(code).then((id) => a.post('/api/bookings').send({
  roomId: id, title: 'Test', category: 'lecture', date, start, end, attendees: 10, ...extra,
}));
const block = async (admin, code, date, start, end, reason = 'Electrical maintenance') => admin.post('/api/admin/room-blocks')
  .send({ roomId: await roomId(code), date, start, end, reason });

describe('temporary closures', () => {
  let admin; let lecturer; let date;
  beforeEach(async () => {
    await resetDb();
    admin = await signedIn('boss@campus.test');
    lecturer = await signedIn('ama@campus.test', 'lecturer');
    date = tomorrow();
  });

  test('a closure takes the room out of search, the board and booking', async () => {
    const res = await block(admin, 'SCB-104', date, '08:00', '12:00');
    assert.equal(res.status, 201);
    assert.equal(res.body.block.reason, 'Electrical maintenance');

    const free = await lecturer.get(`/api/rooms/available?date=${date}&start=10:00&end=11:00`);
    assert.ok(!free.body.rooms.some((r) => r.code === 'SCB-104'));
    const later = await lecturer.get(`/api/rooms/available?date=${date}&start=12:00&end=13:00`);
    assert.ok(later.body.rooms.some((r) => r.code === 'SCB-104'), 'free again once the closure is over');

    const board = await lecturer.get(`/api/rooms/schedule/day?date=${date}`);
    assert.deepEqual(board.body.blocks.map((b) => [b.start_time, b.end_time, b.reason]), [['08:00', '12:00', 'Electrical maintenance']]);

    const refused = await book(lecturer, 'SCB-104', date, '11:00', '13:00');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.clash, 'unavailable');
    assert.match(refused.body.error, /unavailable 08:00–12:00: Electrical maintenance/);
    assert.equal(refused.body.suggestion.start, '12:00');
  });

  test('a closure cannot land on a booking, and the office is told why', async () => {
    await book(lecturer, 'SCB-104', date, '10:00', '12:00');
    const res = await block(admin, 'SCB-104', date, '11:00', '13:00');
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'SCB-104 already has a booking or an unavailable period at that time');
    assert.equal(res.body.bookings.length, 1);
    // Two closures can't overlap either.
    assert.equal((await block(admin, 'SCB-104', date, '13:00', '14:00')).status, 201);
    assert.equal((await block(admin, 'SCB-104', date, '13:30', '15:00')).status, 409);
  });

  test('the database itself refuses an overlap, whichever is written first', async () => {
    const room = await roomId('SCB-105');
    const { id: adminId } = await db.get("SELECT id FROM users WHERE email = 'boss@campus.test'");
    await db.run(`INSERT INTO room_blocks (room_id, date, start_time, end_time, reason, created_by) VALUES (?, ?, '09:00', '11:00', 'Exam', ?)`, [room, date, adminId]);
    await assert.rejects(
      db.run(`INSERT INTO bookings (room_id, user_id, title, category, date, start_time, end_time, attendees, status)
              VALUES (?, ?, 'X', 'lecture', ?, '10:00', '12:00', 5, 'approved')`, [room, adminId, date]),
      (err) => err.code === '23P01' && err.constraint === 'bookings_reject_room_blocks',
    );
    // A cancelled booking may overlap (it holds nothing); making it pending again may not.
    const row = await db.get(`INSERT INTO bookings (room_id, user_id, title, category, date, start_time, end_time, attendees, status)
              VALUES (?, ?, 'X', 'lecture', ?, '10:00', '12:00', 5, 'cancelled') RETURNING id`, [room, adminId, date]);
    await assert.rejects(db.run("UPDATE bookings SET status = 'pending' WHERE id = ?", [row.id]), { code: '23P01' });
    await db.run(`INSERT INTO bookings (room_id, user_id, title, category, date, start_time, end_time, attendees, status)
                  VALUES (?, ?, 'Y', 'lecture', ?, '13:00', '14:00', 5, 'approved')`, [room, adminId, date]);
    await assert.rejects(
      db.run(`INSERT INTO room_blocks (room_id, date, start_time, end_time, reason, created_by) VALUES (?, ?, '13:30', '15:00', 'Late', ?)`, [room, date, adminId]),
      (err) => err.code === '23P01' && err.constraint === 'room_blocks_reject_bookings',
    );
  });

  test('weekly bookings skip a closed week, or are refused without "skip"', async () => {
    const week2 = addDays(date, 7);
    await block(admin, 'NAB-104', week2, '09:00', '10:00', 'Faculty exam');
    const body = { roomId: await roomId('NAB-104'), title: 'Algorithms', category: 'lecture', date, start: '09:00', end: '11:00', attendees: 30, weeks: 3 };
    const preview = await lecturer.post('/api/bookings/series/preview').send(body);
    assert.deepEqual(preview.body.dates.map((d) => d.clash || 'ok'), ['ok', 'unavailable', 'ok']);
    assert.equal((await lecturer.post('/api/bookings/series').send(body)).status, 409);
    const made = await lecturer.post('/api/bookings/series').send({ ...body, skipClashes: true });
    assert.deepEqual(made.body.booked, [date, addDays(date, 14)]);
  });

  test('"make available" removes it; both steps are in the audit log; only admins may', async () => {
    const res = await block(admin, 'LIB-S1', date, '08:00', '09:30', 'Cleaning');
    assert.equal((await admin.get(`/api/admin/room-blocks?date=${date}`)).body.blocks.length, 1);
    assert.equal((await admin.delete(`/api/admin/room-blocks/${res.body.block.id}`)).status, 200);
    assert.equal((await book(lecturer, 'LIB-S1', date, '08:00', '09:00', { category: 'meeting', attendees: 4 })).status, 201);
    const actions = (await db.all("SELECT action FROM audit_log WHERE action LIKE 'room.%block' ORDER BY id")).map((r) => r.action);
    assert.deepEqual(actions, ['room.block', 'room.unblock']);
    const log = await admin.get('/api/admin/audit?group=rooms');
    assert.ok(log.body.entries.some((e) => /closed LIB-S1 .* 08:00–09:30/.test(e.summary)));
    assert.equal((await block(lecturer, 'LIB-S1', date, '10:00', '11:00')).status, 403);
  });

  test('bad closures are refused', async () => {
    assert.match((await block(admin, 'LIB-S1', date, '10:00', '11:00', 'no')).body.error, /reason of 3 to 300/);
    assert.match((await block(admin, 'LIB-S1', date, '10:15', '11:00')).body.error, /hour or half hour/);
    assert.match((await block(admin, 'LIB-S1', addDays(localDate(), -1), '10:00', '11:00')).body.error, /already passed/);
  });
});

describe('booking window and whole hours', () => {
  let admin; let lecturer; let date;
  beforeEach(async () => {
    await resetDb();
    admin = await signedIn('boss@campus.test');
    lecturer = await signedIn('ama@campus.test', 'lecturer');
    date = tomorrow();
  });

  test('defaults: 06:30–20:30, starts every half hour, whole hours up to 4', async () => {
    assert.deepEqual((await admin.get('/api/admin/settings')).body.settings, { open: '06:30', close: '20:30', maxHours: 4, checkInLocation: 'required', studentApproval: 'manual', eventClose: '05:00', eventMaxHours: 12 });
    const meta = (await lecturer.get('/api/rooms/meta')).body.rules;
    assert.deepEqual([meta.open, meta.close, meta.maxHours], ['06:30', '20:30', 4]);
    assert.match((await book(lecturer, 'LT-1', date, '09:00', '10:30')).body.error, /whole hours/);
    assert.equal((await book(lecturer, 'LT-1', date, '06:30', '07:30')).status, 201);
    assert.match((await book(lecturer, 'LT-2', date, '08:00', '13:00')).body.error, /at most 4 hours/);
  });

  test('the office changes the window; it applies at once and is logged', async () => {
    const res = await admin.patch('/api/admin/settings').send({ open: '08:00', close: '18:00', maxHours: 2 });
    assert.deepEqual(res.body.settings, { open: '08:00', close: '18:00', maxHours: 2, checkInLocation: 'required', studentApproval: 'manual', eventClose: '05:00', eventMaxHours: 12 });
    assert.match((await book(lecturer, 'LT-1', date, '07:00', '08:00')).body.error, /between 08:00 and 18:00/);
    assert.match((await book(lecturer, 'LT-1', date, '09:00', '12:00')).body.error, /at most 2 hours/);
    assert.equal((await book(lecturer, 'LT-1', date, '16:00', '18:00')).status, 201);
    const entry = await db.get("SELECT details FROM audit_log WHERE action = 'settings.update'");
    assert.deepEqual(entry.details.maxHours, { from: 4, to: 2 });
    const student = await signedIn('kofi@campus.test');
    assert.equal((await student.patch('/api/admin/settings').send({ maxHours: 6 })).status, 403);
  });

  test('impossible windows are refused', async () => {
    for (const [body, msg] of [
      [{ open: '09:00', close: '09:30' }, /at least an hour/],
      [{ open: '07:15' }, /hour or half hour/],
      [{ maxHours: 7 }, /1 to 6/],
      [{ open: '04:00' }, /from 05:00/],
      [{ open: '10:00', close: '12:00', maxHours: 3 }, /longer than the day/],
    ]) assert.match((await admin.patch('/api/admin/settings').send(body)).body.error, msg);
  });
});

describe('booking details, check-out and the public room list', () => {
  beforeEach(resetDb);

  test('course code and supervisor are saved; category and attendees are optional', async () => {
    const student = await signedIn('kofi@campus.test');
    const res = await book(student, 'LIB-S1', tomorrow(), '10:00', '11:00',
      { category: undefined, attendees: undefined, courseCode: 'csc 401', supervisor: 'Dr. Mensah' });
    assert.equal(res.status, 201);
    const b = res.body.booking;
    assert.deepEqual([b.category, b.attendees, b.course_code, b.supervisor, b.status], ['study', 1, 'CSC 401', 'Dr. Mensah', 'pending']);
  });

  test('a rejection needs a reason', async () => {
    const admin = await signedIn('boss@campus.test');
    const student = await signedIn('kofi@campus.test');
    const { body } = await book(student, 'LIB-S1', tomorrow(), '10:00', '11:00', { category: 'study', attendees: 2 });
    const bare = await admin.post(`/api/admin/bookings/${body.booking.id}/reject`);
    assert.equal(bare.status, 400);
    assert.equal((await admin.post(`/api/admin/bookings/${body.booking.id}/reject`).send({ reason: 'Exams' })).status, 200);
    assert.equal((await admin.get(`/api/admin/bookings?status=rejected&date=${tomorrow()}`)).body.bookings.length, 1);
    assert.equal((await admin.get(`/api/admin/bookings?status=rejected&date=${localDate()}`)).body.bookings.length, 0);
  });

  const minute = toMinutes(localTime());
  const skip = minute < 90 || minute > 22 * 60 ? 'too close to midnight' : false;

  test('check-out after check-in ends the booking now and frees the rest', async () => {
    const a = await signedIn('ama@campus.test', 'lecturer');
    const { id } = await db.get(
      `INSERT INTO bookings (room_id, user_id, title, category, date, start_time, end_time, attendees, status)
       VALUES (?, ?, 'Seminar', 'meeting', ?, ?, ?, 4, 'approved') RETURNING id`,
      [await roomId('NAB-205'), a.user.id, localDate(), fromMinutes(minute - 20), fromMinutes(minute + 60)],
    );
    const early = await a.post(`/api/bookings/${id}/check-out`);
    assert.equal(early.status, 409);
    assert.match(early.body.error, /Check in first/);
    await db.run('UPDATE bookings SET checked_in_at = now() WHERE id = ?', [id]);
    const res = await a.post(`/api/bookings/${id}/check-out`);
    assert.equal(res.status, 200);
    assert.equal(res.body.booking.end_time, localTime());
    assert.equal(res.body.booking.status, 'approved');
    assert.ok(res.body.booking.checked_out_at);
    assert.equal((await a.post(`/api/bookings/${id}/check-out`)).status, 409);
    const other = await signedIn('yaw@campus.test', 'lecturer');
    assert.equal((await other.post(`/api/bookings/${id}/check-out`)).status, 404);
    assert.equal((await db.get("SELECT details FROM audit_log WHERE action = 'booking.check_out'")).details.planned_end, fromMinutes(minute + 60));
  }, { skip });

  test('the public room list shows free periods without booking details', async () => {
    const lecturer = await signedIn('ama@campus.test', 'lecturer');
    const admin = await signedIn('boss@campus.test');
    const date = tomorrow();
    await book(lecturer, 'LT-3', date, '09:00', '11:00', { title: 'Secret seminar' });
    await block(admin, 'LT-3', date, '13:00', '14:30');
    const res = await agent().get(`/api/public/rooms?date=${date}`);
    assert.equal(res.status, 200);
    const lt3 = res.body.rooms.find((r) => r.code === 'LT-3');
    assert.deepEqual(lt3.freePeriods, [
      { start: '06:30', end: '09:00' }, { start: '11:00', end: '13:00' }, { start: '14:30', end: '20:30' },
    ]);
    assert.deepEqual(lt3.firstFree, { start: '06:30', end: '09:00' });
    assert.ok(!JSON.stringify(res.body).includes('Secret seminar'));
    assert.equal((await agent().get('/api/public/rooms?date=2020-01-01')).status, 400);
  });

  test('/api/access is the same as /api/access-requests', async () => {
    const a = await signedIn('kofi@campus.test');
    const res = await a.get('/api/access/mine');
    assert.equal(res.status, 200);
    assert.equal(res.body.request, null);
  });
});

describe('directions to buildings', () => {
  beforeEach(resetDb);

  test('a building with its own point gets exact directions; otherwise Google Maps looks it up by name', async () => {
    const { directionsUrl } = require('../src/utils/geo');
    const exact = new URL(directionsUrl({ name: 'NLT', latitude: 5.1101, longitude: -1.2952, radius_m: 150 }));
    assert.equal(exact.origin + exact.pathname, 'https://www.google.com/maps/dir/');
    assert.equal(exact.searchParams.get('destination'), '5.1101,-1.2952');
    assert.equal(exact.searchParams.get('travelmode'), 'walking');
    const campus = new URL(directionsUrl({ name: 'New Lecture Theatre', latitude: 5.115833, longitude: -1.290833, radius_m: 3000 }));
    assert.equal(campus.searchParams.get('destination'), 'New Lecture Theatre, University of Cape Coast, Ghana');
    assert.match(directionsUrl({ name: 'Science Block' }), /destination=Science\+Block/);

    await db.run("UPDATE buildings SET latitude = 5.11, longitude = -1.29, radius_m = 120 WHERE code = 'LIB'");
    const rooms = (await agent().get(`/api/public/rooms?date=${tomorrow()}`)).body.rooms;
    assert.match(rooms.find((r) => r.code === 'LIB-S1').directions, /destination=5.11%2C-1.29/);
    assert.match(rooms.find((r) => r.code === 'SCB-104').directions, /destination=Science\+Block/);
    assert.ok(!('building_latitude' in rooms[0]), 'coordinates are not sent as such');
    const a = await signedIn('ama@campus.test', 'lecturer');
    await book(a, 'LIB-S1', tomorrow(), '10:00', '11:00', { category: 'meeting', attendees: 4 });
    const mine = (await a.get('/api/bookings/mine')).body.bookings;
    assert.match(mine[0].directions, /destination=5.11%2C-1.29/);
  });
});


describe('student requests approved automatically', () => {
  beforeEach(resetDb);

  test('with "auto", a student booking is confirmed at once; the office can switch back to manual', async () => {
    const admin = await signedIn('boss@campus.test');
    const student = await signedIn('kofi@campus.test');
    await admin.patch('/api/admin/settings').send({ studentApproval: 'auto' });
    const res = await book(student, 'LIB-S1', tomorrow(), '10:00', '11:00', { category: 'study', attendees: 3 });
    assert.equal(res.status, 201);
    assert.equal(res.body.booking.status, 'approved');
    assert.equal((await admin.get('/api/admin/pending-counts')).body.bookings, 0, 'nothing waits in Approvals');
    assert.equal((await agent().get(`/api/public/rooms?date=${tomorrow()}`)).body.studentsNeedApproval, false);
    // The usual limits still hold.
    assert.equal((await book(student, 'LT-1', tomorrow(), '12:00', '13:00', { category: 'study' })).status, 403, 'staff-only room');
    assert.equal((await book(student, 'LIB-S2', tomorrow(), '12:00', '13:00', { category: 'lecture' })).status, 403, 'staff category');
    await admin.patch('/api/admin/settings').send({ studentApproval: 'manual' });
    const later = await book(student, 'LIB-S2', tomorrow(), '14:00', '15:00', { category: 'study', attendees: 3 });
    assert.equal(later.body.booking.status, 'pending');
    assert.match((await admin.patch('/api/admin/settings').send({ studentApproval: 'never' })).body.error, /auto" or "manual/);
  });
});

describe('event rooms: bookable overnight', () => {
  let admin; let lecturer; let date; let next; let hall;
  beforeEach(async () => {
    await resetDb();
    admin = await signedIn('boss@campus.test');
    lecturer = await signedIn('ama@campus.test', 'lecturer');
    date = tomorrow();
    next = addDays(date, 1);
    hall = await roomId('NAB-001');
    await db.run('UPDATE rooms SET extended_hours = true WHERE id = ?', [hall]);
  });
  const parts = (id) => db.all('SELECT date, start_time, end_time, status, parent_id FROM bookings WHERE id = ? OR parent_id = ? ORDER BY id', [id, id]);

  test('6 PM to 5 AM is one booking, stored as two linked parts that both hold the room', async () => {
    const res = await book(lecturer, 'NAB-001', date, '18:00', '05:00', { category: 'event', attendees: 200, title: 'Hall week' });
    assert.equal(res.status, 201);
    const id = res.body.booking.id;
    assert.deepEqual((await parts(id)).map((p) => [p.date, p.start_time, p.end_time, p.status, p.parent_id]), [
      [date, '18:00', '24:00', 'approved', null], [next, '00:00', '05:00', 'approved', id],
    ]);
    // Both parts are taken: a clash before and after midnight.
    assert.equal((await book(admin, 'NAB-001', date, '22:00', '23:00', { category: 'event' })).status, 409);
    const after = await book(admin, 'NAB-001', next, '07:00', '08:00', { category: 'meeting' });
    assert.equal(after.status, 201, 'free again in the morning');
    const mine = (await lecturer.get('/api/bookings/mine')).body.bookings;
    assert.deepEqual(mine.map((b) => [b.start_time, b.end_time, b.next_day_end]), [['18:00', '24:00', '05:00']], 'shown once, with the next-day end');
    const day = (await agent().get(`/api/public/rooms?date=${date}`)).body;
    const free = day.rooms.find((r) => r.code === 'NAB-001');
    assert.equal(free.extended_hours, true);
    assert.deepEqual(free.freePeriods.at(-1), { start: '06:30', end: '18:00' });
    // Cancelling cancels both parts.
    await lecturer.post(`/api/bookings/${id}/cancel`);
    assert.deepEqual((await parts(id)).map((p) => p.status), ['cancelled', 'cancelled']);
  });

  test('the rules: only event rooms, until 05:00, at most 12 hours (both set in Settings)', async () => {
    assert.match((await book(lecturer, 'LT-1', date, '18:00', '22:00')).body.error, /between 06:30 and 20:30/);
    assert.match((await book(lecturer, 'NAB-001', date, '18:00', '06:00', { category: 'event' })).body.error, /until 05:00 the next morning/);
    assert.match((await book(lecturer, 'NAB-001', date, '08:00', '21:00', { category: 'event' })).body.error, /at most 12 hours/);
    assert.equal((await book(lecturer, 'NAB-001', date, '07:00', '18:00', { category: 'event' })).status, 201, '11 hours in the day is fine');
    await admin.patch('/api/admin/settings').send({ eventClose: '02:00', eventMaxHours: 6 });
    assert.match((await book(admin, 'NAB-001', next, '20:00', '03:00', { category: 'event' })).body.error, /until 02:00/);
    assert.equal((await book(admin, 'NAB-001', next, '20:00', '02:00', { category: 'event' })).status, 201);
    assert.match((await admin.patch('/api/admin/settings').send({ eventMaxHours: 30 })).body.error, /1 to 24/);
  });

  test('an overnight booking nobody checks in to is released whole; its calendar event ends next morning', async () => {
    const res = await book(lecturer, 'NAB-001', date, '19:00', '04:00', { category: 'event', title: 'Gala' });
    const id = res.body.booking.id;
    const ics = await lecturer.raw.get(`/api/bookings/${id}/calendar.ics`).buffer(true)
      .parse((r, done) => { let s = ''; r.on('data', (c) => { s += c; }); r.on('end', () => done(null, s)); });
    assert.match(ics.body, new RegExp(`DTEND[^:]*:${next.replace(/-/g, '')}T040000`));
    assert.equal((ics.body.match(/BEGIN:VEVENT/g) || []).length, 1);
    // Pretend the start has passed without a check-in.
    await db.run("UPDATE bookings SET date = current_date, start_time = '00:30', updated_at = now() - interval '1 day' WHERE id = ?", [id]);
    await db.run("UPDATE bookings SET date = current_date + 1 WHERE parent_id = ?", [id]);
    const { releaseNoShows } = require('../src/services/checkin');
    await releaseNoShows(new Date(new Date().setHours(1, 0, 0, 0)));
    assert.deepEqual((await parts(id)).map((p) => p.status), ['released', 'released']);
  });
});
