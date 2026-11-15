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
    assert.deepEqual((await admin.get('/api/admin/settings')).body.settings, { open: '06:30', close: '20:30', maxHours: 4 });
    const meta = (await lecturer.get('/api/rooms/meta')).body.rules;
    assert.deepEqual([meta.open, meta.close, meta.maxHours], ['06:30', '20:30', 4]);
    assert.match((await book(lecturer, 'LT-1', date, '09:00', '10:30')).body.error, /whole hours/);
    assert.equal((await book(lecturer, 'LT-1', date, '06:30', '07:30')).status, 201);
    assert.match((await book(lecturer, 'LT-2', date, '08:00', '13:00')).body.error, /at most 4 hours/);
  });

  test('the office changes the window; it applies at once and is logged', async () => {
    const res = await admin.patch('/api/admin/settings').send({ open: '08:00', close: '18:00', maxHours: 2 });
    assert.deepEqual(res.body.settings, { open: '08:00', close: '18:00', maxHours: 2 });
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
