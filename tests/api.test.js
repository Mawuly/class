'use strict';
const { test, before, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { app, db, request, agent, signedIn, resetDb, roomId, tomorrow, PASSWORD } = require('./helpers');
const { localDate, addDays } = require('../src/utils/time');

before(resetDb);
after(() => db.pool.end());

describe('auth', () => {
  beforeEach(resetDb);

  test('register signs you in as a student', async () => {
    const a = agent();
    const reg = await a.post('/api/auth/register').send({ name: 'Ama', email: 'Ama@Campus.test', password: PASSWORD });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.role, 'student');
    assert.equal(reg.body.user.email, 'ama@campus.test');
    const cookie = reg.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.equal((await a.get('/api/auth/me')).body.user.email, 'ama@campus.test');
  });

  test('a role sent at registration is ignored', async () => {
    const res = await agent().post('/api/auth/register')
      .send({ name: 'Sneaky', email: 'sneaky@campus.test', password: PASSWORD, role: 'admin' });
    assert.equal(res.body.user.role, 'student');
  });

  test('weak passwords and duplicate emails are refused', async () => {
    const weak = await agent().post('/api/auth/register').send({ name: 'Kofi', email: 'k@campus.test', password: 'password' });
    assert.equal(weak.status, 400);
    await signedIn('dup@campus.test');
    const dup = await agent().post('/api/auth/register').send({ name: 'Dup', email: 'DUP@campus.test', password: PASSWORD });
    assert.equal(dup.status, 409);
  });

  test('login gives the same answer for a wrong password and an unknown email', async () => {
    await signedIn('kofi@campus.test');
    const wrongPw = await agent().post('/api/auth/login').send({ email: 'kofi@campus.test', password: 'Wrong12345' });
    const noUser = await agent().post('/api/auth/login').send({ email: 'nobody@campus.test', password: 'Wrong12345' });
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.deepEqual(wrongPw.body, noUser.body);
    const ok = await agent().post('/api/auth/login').send({ email: 'KOFI@campus.test', password: PASSWORD });
    assert.equal(ok.status, 200);
  });

  test('a deactivated user is signed out on their next request', async () => {
    const a = await signedIn('gone@campus.test');
    await db.run('UPDATE users SET is_active = false WHERE id = ?', [a.user.id]);
    assert.equal((await a.get('/api/auth/me')).status, 401);
  });

  test('changes without the X-Requested-With header are refused (CSRF)', async () => {
    const a = await signedIn('csrf@campus.test');
    const res = await a.raw.post('/api/bookings').send({});
    assert.equal(res.status, 403);
  });

  test('signed-out requests get 401', async () => {
    assert.equal((await agent().get('/api/bookings/mine')).status, 401);
  });
});

describe('bookings', () => {
  let student; let lecturer; let lecturer2; let admin;
  const date = tomorrow();

  beforeEach(async () => {
    await resetDb();
    student = await signedIn('student@campus.test');
    lecturer = await signedIn('lecturer@campus.test', 'lecturer');
    lecturer2 = await signedIn('lecturer2@campus.test', 'lecturer');
    admin = await signedIn('admin@campus.test', 'admin');
  });

  const book = async (who, code, start, end, extra = {}) => who.post('/api/bookings').send({
    roomId: await roomId(code), title: 'Test', category: 'lecture', date, start, end, attendees: 10, ...extra,
  });

  test('a lecturer booking is approved straight away', async () => {
    const res = await book(lecturer, 'LT-2', '08:30', '10:30', { courseCode: 'csc 301' });
    assert.equal(res.status, 201);
    assert.equal(res.body.booking.status, 'approved');
    assert.equal(res.body.booking.course_code, 'CSC 301');
    assert.equal(res.body.booking.start_time, '08:30');
  });

  test('a student cannot book a lecture hall (403)', async () => {
    const res = await book(student, 'LT-1', '08:00', '09:00', { category: 'study' });
    assert.equal(res.status, 403);
  });

  test('a student cannot book a seminar room for a lecture (403)', async () => {
    const res = await book(student, 'SCB-104', '08:00', '09:00', { category: 'lecture' });
    assert.equal(res.status, 403);
  });

  test('a student request waits for approval', async () => {
    const res = await book(student, 'LIB-S1', '10:00', '12:00', { category: 'study', attendees: 4 });
    assert.equal(res.status, 201);
    assert.equal(res.body.booking.status, 'pending');
  });

  test('a room clash returns 409, names the booking and suggests the nearest free slot', async () => {
    await book(lecturer, 'LT-2', '09:00', '10:00', { courseCode: 'CSC 301' });
    const res = await book(lecturer2, 'LT-2', '08:30', '10:30');
    assert.equal(res.status, 409);
    assert.equal(res.body.clash, 'room');
    assert.match(res.body.error, /LT-2 is taken 09:00–10:00 by CSC 301/);
    assert.deepEqual(res.body.suggestion, { date, start: '10:00', end: '12:00' });
  });

  test('back-to-back bookings are allowed (08:00–10:00 then 10:00–12:00)', async () => {
    assert.equal((await book(lecturer, 'LT-3', '08:00', '10:00')).status, 201);
    assert.equal((await book(lecturer2, 'LT-3', '10:00', '12:00')).status, 201);
  });

  test('you cannot be in two rooms at once', async () => {
    await book(lecturer, 'LT-1', '08:00', '10:00');
    const res = await book(lecturer, 'LT-2', '09:00', '11:00');
    assert.equal(res.status, 409);
    assert.equal(res.body.clash, 'user');
  });

  test('a pending student request holds its slot', async () => {
    await book(student, 'SCB-104', '14:00', '16:00', { category: 'meeting' });
    const res = await book(lecturer, 'SCB-104', '15:00', '16:00');
    assert.equal(res.status, 409);
  });

  test('more attendees than seats is refused', async () => {
    const res = await book(student, 'LIB-S1', '10:00', '11:00', { category: 'study', attendees: 7 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /holds 6/);
  });

  test('the database blocks simultaneous requests for the same slot', async () => {
    const room = await roomId('NAB-001');
    const send = (who) => who.post('/api/bookings').send({
      roomId: room, title: 'Race', category: 'lecture', date, start: '12:00', end: '13:00', attendees: 50,
    });
    const results = await Promise.all([send(lecturer), send(lecturer2), send(admin)]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409]);
    const { n } = await db.get("SELECT count(*)::int AS n FROM bookings WHERE room_id = ? AND status = 'approved'", [room]);
    assert.equal(n, 1);
  });

  test('cancelling frees the slot', async () => {
    const first = await book(lecturer, 'LT-3', '13:00', '14:00');
    const cancel = await lecturer.post(`/api/bookings/${first.body.booking.id}/cancel`);
    assert.equal(cancel.body.booking.status, 'cancelled');
    assert.equal((await book(lecturer2, 'LT-3', '13:00', '14:00')).status, 201);
  });

  test("you cannot cancel someone else's booking", async () => {
    const b = await book(lecturer, 'LT-3', '13:00', '14:00');
    assert.equal((await lecturer2.post(`/api/bookings/${b.body.booking.id}/cancel`)).status, 404);
  });

  test('my bookings lists only my own', async () => {
    await book(lecturer, 'LT-3', '13:00', '14:00');
    await book(lecturer2, 'LT-2', '13:00', '14:00');
    const mine = await lecturer.get('/api/bookings/mine');
    assert.equal(mine.body.bookings.length, 1);
    assert.equal(mine.body.bookings[0].room_code, 'LT-3');
  });

  test('approval flow: admin approves, student is notified', async () => {
    const req = await book(student, 'LIB-S2', '10:00', '12:00', { category: 'study', attendees: 4 });
    assert.equal((await student.get('/api/admin/bookings')).status, 403);

    const queue = await admin.get('/api/admin/bookings?status=pending');
    assert.equal(queue.body.bookings.length, 1);

    const ok = await admin.post(`/api/admin/bookings/${req.body.booking.id}/approve`);
    assert.equal(ok.body.booking.status, 'approved');
    assert.equal((await admin.post(`/api/admin/bookings/${req.body.booking.id}/reject`)).status, 409);

    const notes = await student.get('/api/notifications');
    assert.equal(notes.body.unread, 1);
    assert.match(notes.body.notifications[0].message, /LIB-S2 .* was approved/);
  });

  test('rejection frees the slot and records the reason', async () => {
    const req = await book(student, 'SCB-105', '10:00', '12:00', { category: 'meeting' });
    await admin.post(`/api/admin/bookings/${req.body.booking.id}/reject`).send({ reason: 'Reserved for exams' });
    const notes = await student.get('/api/notifications');
    assert.match(notes.body.notifications[0].message, /rejected\. Reason: Reserved for exams/);
    assert.equal((await book(lecturer, 'SCB-105', '10:00', '12:00')).status, 201);
  });

  test('bookings and admin decisions are written to the audit log', async () => {
    const req = await book(student, 'LIB-S2', '10:00', '12:00', { category: 'study', attendees: 4 });
    await admin.post(`/api/admin/bookings/${req.body.booking.id}/approve`);
    const actions = (await db.all('SELECT action FROM audit_log ORDER BY id')).map((r) => r.action);
    assert.ok(actions.includes('booking.create'));
    assert.ok(actions.includes('booking.approve'));
  });
});

describe('rooms', () => {
  let student; let lecturer;
  const date = tomorrow();

  beforeEach(async () => {
    await resetDb();
    student = await signedIn('sam@campus.test');
    lecturer = await signedIn('lee@campus.test', 'lecturer');
  });

  test('free-room finder: smallest suitable room first, booked rooms left out', async () => {
    await lecturer.post('/api/bookings').send({
      roomId: await roomId('SCB-105'), title: 'Taken', category: 'tutorial', date, start: '09:00', end: '11:00', attendees: 20,
    });
    const res = await lecturer.get(`/api/rooms/available?date=${date}&start=10:00&end=11:00&minCapacity=25`);
    const codes = res.body.rooms.map((r) => r.code);
    assert.ok(!codes.includes('SCB-105'));
    assert.equal(codes[0], 'SCB-104'); // 40 seats: the smallest free room that fits 25
    assert.equal(res.body.rooms[0].bestFit, true);
    const caps = res.body.rooms.map((r) => r.capacity);
    assert.deepEqual(caps, [...caps].sort((a, b) => a - b));
  });

  test('free-room finder hides staff-only rooms from students and filters by facility', async () => {
    const res = await student.get(`/api/rooms/available?date=${date}&start=10:00&end=11:00&facilities=projector`);
    assert.ok(res.body.rooms.length > 0);
    for (const r of res.body.rooms) {
      assert.equal(r.bookable_by, 'all');
      assert.ok(r.facilities.includes('projector'));
    }
  });

  test('day board shows bookings and marks your own', async () => {
    await lecturer.post('/api/bookings').send({
      roomId: await roomId('LT-1'), title: 'Mine', category: 'lecture', date, start: '08:00', end: '10:00', attendees: 100,
    });
    const res = await lecturer.get(`/api/rooms/schedule/day?date=${date}`);
    assert.equal(res.body.rooms.length, 16);
    assert.equal(res.body.bookings.length, 1);
    assert.equal(res.body.bookings[0].mine, true);
    assert.equal(res.body.bookings[0].user_id, undefined);
  });

  test('a bad room id is a 404, not a server error', async () => {
    assert.equal((await student.get('/api/rooms/abc')).status, 404);
    assert.equal((await student.get('/api/rooms/99999')).status, 404);
  });

  test('public "now" endpoint works without signing in and shows no names', async () => {
    const res = await agent().get('/api/public/now');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 16);
    assert.equal(typeof res.body.free, 'number');
    assert.ok(!JSON.stringify(res.body).includes('@'));
  });
});

describe('health', () => {
  test('reports a working database without signing in', async () => {
    await resetDb();
    const res = await agent().get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.database, /connected, 16 rooms/);
  });
});

describe('zero-step setup', () => {
  const { resetSetupState } = require('../src/db/setup');

  test('a brand-new empty database gets its tables and rooms on the first request', async () => {
    await db.pool.query(`DROP TABLE IF EXISTS app_meta, password_resets, access_requests, audit_log, notifications, bookings, booking_series, rooms, buildings, users CASCADE`);
    resetSetupState();
    const res = await agent().get('/api/public/now');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 16);
    const health = await agent().get('/api/health');
    assert.equal(health.body.ok, true);
    assert.match(health.body.database, /16 rooms, 0 admins/);
    assert.match(health.body.next, /Register on the site with boss@campus.test/);
  });

  test('setup runs safely when several requests arrive at once', async () => {
    await db.pool.query(`DROP TABLE IF EXISTS app_meta, password_resets, access_requests, audit_log, notifications, bookings, booking_series, rooms, buildings, users CASCADE`);
    resetSetupState();
    const results = await Promise.all([1, 2, 3, 4].map(() => agent().get('/api/public/now')));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
    const { n } = await db.get('SELECT count(*)::int AS n FROM rooms');
    assert.equal(n, 16);
  });

  test('registering with an ADMIN_EMAILS address makes you admin; others stay students', async () => {
    await resetDb();
    const boss = await agent().post('/api/auth/register').send({ name: 'Boss', email: 'boss@campus.test', password: PASSWORD });
    assert.equal(boss.body.user.role, 'admin');
    const other = await agent().post('/api/auth/register').send({ name: 'Other', email: 'other@campus.test', password: PASSWORD });
    assert.equal(other.body.user.role, 'student');
  });

  test('an existing account is promoted when its email is in ADMIN_EMAILS', async () => {
    await resetDb();
    await agent().post('/api/auth/register').send({ name: 'Head', email: 'head@campus.test', password: PASSWORD });
    await db.run("UPDATE users SET role = 'student' WHERE email = 'head@campus.test'");
    const login = await agent().post('/api/auth/login').send({ email: 'head@campus.test', password: PASSWORD });
    assert.equal(login.body.user.role, 'admin');
  });
});

describe('connection strings', () => {
  const { cleanDatabaseUrl } = require('../src/config');

  test("Supabase's sslmode and pooler flags are removed; the password is kept intact", () => {
    const url = 'postgres://postgres.abc:p%40ss%23w0rd@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x';
    const clean = cleanDatabaseUrl(url);
    assert.equal(clean, 'postgres://postgres.abc:p%40ss%23w0rd@aws-0-eu-central-1.pooler.supabase.com:6543/postgres');
    assert.equal(cleanDatabaseUrl('postgres://u:p@h:5432/db?pgbouncer=true'), 'postgres://u:p@h:5432/db');
  });
});

describe('approval queue', () => {
  let student; let admin; let lecturer;
  const date = tomorrow();

  beforeEach(async () => {
    await resetDb();
    student = await signedIn('kwame@campus.test');
    admin = await signedIn('registry@campus.test', 'admin');
    lecturer = await signedIn('mensah@campus.test', 'lecturer');
    await db.run("UPDATE users SET department = 'Computer Science', index_number = '10912345' WHERE email = 'kwame@campus.test'");
  });

  const request = async (code, start, end) => student.post('/api/bookings').send({
    roomId: await roomId(code), title: 'Group revision', category: 'study', date, start, end, attendees: 4,
  });

  test('the queue shows who is asking, their department and the room size', async () => {
    await request('LIB-S1', '10:00', '12:00');
    const { body } = await admin.get('/api/admin/bookings?status=pending');
    const b = body.bookings[0];
    assert.equal(b.user_name, 'kwame');
    assert.equal(b.user_department, 'Computer Science');
    assert.equal(b.user_index_number, '10912345');
    assert.equal(b.room_capacity, 6);
    assert.equal(b.ended, false);
  });

  test('context lists the room\'s other bookings that day and the requester\'s history', async () => {
    const req = await request('LIB-S3', '10:00', '12:00');
    await lecturer.post('/api/bookings').send({
      roomId: await roomId('LIB-S3'), title: 'Seminar', category: 'tutorial', date, start: '13:00', end: '14:00', attendees: 10,
    });
    await request('LIB-S1', '14:00', '15:00');
    const { body } = await admin.get(`/api/admin/bookings/${req.body.booking.id}/context`);
    assert.deepEqual(body.sameRoom.map((x) => x.title), ['Seminar']);
    assert.equal(body.requester.otherPending, 1);
    assert.equal((await student.get(`/api/admin/bookings/${req.body.booking.id}/context`)).status, 403);
  });

  test('decided tab lists recent decisions with who decided and why', async () => {
    const a = await request('LIB-S1', '10:00', '11:00');
    const r = await request('LIB-S2', '12:00', '13:00');
    await admin.post(`/api/admin/bookings/${a.body.booking.id}/approve`);
    await admin.post(`/api/admin/bookings/${r.body.booking.id}/reject`).send({ reason: 'Reserved for exams' });
    const { body } = await admin.get('/api/admin/bookings?status=decided');
    assert.deepEqual(body.bookings.map((x) => x.status).sort(), ['approved', 'rejected']);
    const rejected = body.bookings.find((x) => x.status === 'rejected');
    assert.equal(rejected.decided_by_name, 'registry');
    assert.equal(rejected.decision_reason, 'Reserved for exams');
  });

  test('a request whose time has passed can be rejected but not approved', async () => {
    const yesterday = addDays(localDate(), -1);
    const { id } = await db.get(
      `INSERT INTO bookings (room_id, user_id, title, category, date, start_time, end_time, attendees, status)
       VALUES (?, ?, 'Old request', 'study', ?, '10:00', '11:00', 2, 'pending') RETURNING id`,
      [await roomId('LIB-S1'), student.user.id, yesterday],
    );
    const queue = await admin.get('/api/admin/bookings?status=pending');
    assert.equal(queue.body.bookings.find((x) => x.id === id).ended, true);
    const approve = await admin.post(`/api/admin/bookings/${id}/approve`);
    assert.equal(approve.status, 409);
    assert.match(approve.body.error, /already passed/);
    assert.equal((await admin.post(`/api/admin/bookings/${id}/reject`)).status, 200);
  });
});

describe('room management', () => {
  let admin; let lecturer; let student;
  const date = tomorrow();

  beforeEach(async () => {
    await resetDb();
    admin = await signedIn('ops@campus.test', 'admin');
    lecturer = await signedIn('ofori@campus.test', 'lecturer');
    student = await signedIn('esi@campus.test');
  });

  const buildingId = async (code) => (await db.get('SELECT id FROM buildings WHERE code = ?', [code])).id;

  test('only admins can manage rooms', async () => {
    assert.equal((await lecturer.get('/api/admin/rooms')).status, 403);
    assert.equal((await student.post('/api/admin/rooms').send({})).status, 403);
  });

  test('overview lists buildings and rooms with usage counts', async () => {
    await lecturer.post('/api/bookings').send({ roomId: await roomId('LT-3'), title: 'X', category: 'lecture', date, start: '08:00', end: '09:00', attendees: 50 });
    const { body } = await admin.get('/api/admin/rooms');
    assert.equal(body.buildings.length, 4);
    assert.equal(body.rooms.length, 16);
    const lt3 = body.rooms.find((r) => r.code === 'LT-3');
    assert.equal(lt3.upcoming, 1);
    assert.equal(lt3.total_bookings, 1);
  });

  test('add a building and a room; codes are upper-cased and facilities normalised', async () => {
    const b = await admin.post('/api/admin/buildings').send({ code: 'eng', name: 'Engineering Block' });
    assert.equal(b.status, 201);
    assert.equal(b.body.building.code, 'ENG');
    const r = await admin.post('/api/admin/rooms').send({
      buildingId: b.body.building.id, code: 'eng-101', name: 'Drawing Studio', type: 'lab', capacity: 40, floor: 1,
      facilities: ['Projector', 'Video conf', 'projector'],
    });
    assert.equal(r.status, 201);
    const room = await db.get('SELECT code, facilities, bookable_by FROM rooms WHERE id = ?', [r.body.room.id]);
    assert.equal(room.code, 'ENG-101');
    assert.deepEqual(room.facilities, ['projector', 'video_conf']);
    assert.equal(room.bookable_by, 'staff'); // labs default to staff only
    // It can be found and booked straight away
    const found = await lecturer.get(`/api/rooms/available?date=${date}&start=10:00&end=11:00&minCapacity=35&type=lab`);
    assert.ok(found.body.rooms.some((x) => x.code === 'ENG-101'));
  });

  test('duplicate codes and bad input are refused clearly', async () => {
    const dup = await admin.post('/api/admin/rooms').send({ buildingId: await buildingId('LTB'), code: 'lt-1', name: 'Copy', type: 'seminar', capacity: 10 });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already a room with the code LT-1/);
    const bad = await admin.post('/api/admin/rooms').send({ buildingId: await buildingId('LTB'), code: 'LT 9', name: 'X', type: 'seminar', capacity: 10 });
    assert.equal(bad.status, 400);
    const seats = await admin.post('/api/admin/rooms').send({ buildingId: await buildingId('LTB'), code: 'LT-9', name: 'Hall', type: 'seminar', capacity: 0 });
    assert.equal(seats.status, 400);
  });

  test('edit a room: new capacity and who can book it', async () => {
    const id = await roomId('SCB-105');
    const res = await admin.patch(`/api/admin/rooms/${id}`).send({ capacity: 24, bookableBy: 'staff' });
    assert.equal(res.status, 200);
    const req = await student.post('/api/bookings').send({ roomId: id, title: 'Study', category: 'study', date, start: '10:00', end: '11:00', attendees: 4 });
    assert.equal(req.status, 403);
  });

  test('deactivating a room with upcoming bookings asks first, then cancels and notifies', async () => {
    const id = await roomId('SCB-104');
    await student.post('/api/bookings').send({ roomId: id, title: 'Group work', category: 'meeting', date, start: '10:00', end: '11:00', attendees: 5 });
    const ask = await admin.patch(`/api/admin/rooms/${id}`).send({ isActive: false });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.upcoming, 1);
    assert.equal(ask.body.needsConfirm, true);
    assert.equal((await db.get('SELECT is_active FROM rooms WHERE id = ?', [id])).is_active, true);

    const ok = await admin.patch(`/api/admin/rooms/${id}`).send({ isActive: false, cancelUpcoming: true });
    assert.equal(ok.body.cancelled, 1);
    const notes = await student.get('/api/notifications');
    assert.match(notes.body.notifications[0].message, /SCB-104 .* cancelled because the room is no longer available/);
    // Gone from searches and the board, still in the admin list
    const found = await lecturer.get(`/api/rooms/available?date=${date}&start=12:00&end=13:00`);
    assert.ok(!found.body.rooms.some((x) => x.code === 'SCB-104'));
    const board = await lecturer.get(`/api/rooms/schedule/day?date=${date}`);
    assert.ok(!board.body.rooms.some((x) => x.code === 'SCB-104'));
    assert.equal((await admin.get('/api/admin/rooms')).body.rooms.find((x) => x.code === 'SCB-104').is_active, false);
    // And back again
    await admin.patch(`/api/admin/rooms/${id}`).send({ isActive: true });
    assert.equal((await db.get('SELECT is_active FROM rooms WHERE id = ?', [id])).is_active, true);
  });

  test('a never-booked room can be deleted; a booked one must be deactivated instead', async () => {
    const unused = await roomId('NAB-206');
    assert.equal((await admin.delete(`/api/admin/rooms/${unused}`)).status, 200);
    const used = await roomId('LT-2');
    await lecturer.post('/api/bookings').send({ roomId: used, title: 'X', category: 'lecture', date, start: '08:00', end: '09:00', attendees: 50 });
    const refused = await admin.delete(`/api/admin/rooms/${used}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Deactivate it instead/);
  });

  test('a building can only be deleted once it is empty', async () => {
    const lib = await buildingId('LIB');
    assert.equal((await admin.delete(`/api/admin/buildings/${lib}`)).status, 409);
    for (const code of ['LIB-S1', 'LIB-S2', 'LIB-S3', 'LIB-G1']) await admin.delete(`/api/admin/rooms/${await roomId(code)}`);
    assert.equal((await admin.delete(`/api/admin/buildings/${lib}`)).status, 200);
  });

  test('room changes are written to the audit log', async () => {
    await admin.patch(`/api/admin/rooms/${await roomId('LT-3')}`).send({ name: 'Lecture Theatre Three' });
    const row = await db.get("SELECT action, details FROM audit_log WHERE action = 'room.update'");
    assert.equal(row.details.name, 'Lecture Theatre Three');
  });
});

describe('user management', () => {
  let admin; let lecturer; let student;
  const date = tomorrow();

  beforeEach(async () => {
    await resetDb();
    admin = await signedIn('chief@campus.test', 'admin');
    lecturer = await signedIn('amoah@campus.test', 'lecturer');
    student = await signedIn('akua@campus.test');
    await db.run("UPDATE users SET index_number = '10955555', department = 'Law' WHERE email = 'akua@campus.test'");
  });

  test('only admins can list or change people', async () => {
    assert.equal((await lecturer.get('/api/admin/users')).status, 403);
    assert.equal((await student.patch(`/api/admin/users/${student.user.id}`).send({ role: 'admin' })).status, 403);
  });

  test('list, search by name, email or index number, and filter by role', async () => {
    const all = await admin.get('/api/admin/users');
    assert.equal(all.body.users.length, 3);
    assert.deepEqual(all.body.counts, { active: 3, inactive: 0, students: 1, lecturers: 1, admins: 1 });
    assert.equal((await admin.get('/api/admin/users?q=10955')).body.users[0].email, 'akua@campus.test');
    assert.equal((await admin.get('/api/admin/users?q=AMOAH')).body.users[0].role, 'lecturer');
    assert.equal((await admin.get('/api/admin/users?role=student')).body.users.length, 1);
    assert.equal((await admin.get('/api/admin/users?q=%25')).body.users.length, 0); // % is matched literally
  });

  test('making a student a lecturer takes effect on their next request, and they are told', async () => {
    const res = await admin.patch(`/api/admin/users/${student.user.id}`).send({ role: 'lecturer' });
    assert.equal(res.status, 200);
    assert.equal((await student.get('/api/auth/me')).body.user.role, 'lecturer');
    const booking = await student.post('/api/bookings').send({
      roomId: await roomId('LT-1'), title: 'Moot court', category: 'lecture', date, start: '09:00', end: '10:00', attendees: 50,
    });
    assert.equal(booking.body.booking.status, 'approved');
    const notes = await student.get('/api/notifications');
    assert.match(notes.body.notifications[0].message, /now a lecturer account/);
  });

  test('you cannot change your own role or deactivate yourself', async () => {
    const role = await admin.patch(`/api/admin/users/${admin.user.id}`).send({ role: 'student' });
    assert.equal(role.status, 403);
    const off = await admin.patch(`/api/admin/users/${admin.user.id}`).send({ isActive: false });
    assert.equal(off.status, 403);
  });

  test('an admin can demote another admin, and the system never ends up without an active admin', async () => {
    const deputy = await signedIn('deputy@campus.test', 'admin');
    assert.equal((await deputy.patch(`/api/admin/users/${admin.user.id}`).send({ role: 'lecturer' })).status, 200);
    // The chief is now a lecturer and can no longer manage people.
    assert.equal((await admin.patch(`/api/admin/users/${deputy.user.id}`).send({ role: 'student' })).status, 403);
    // Backstop below the API: removing the only active admin is refused even if called directly.
    const userAdmin = require('../src/services/userAdmin');
    await assert.rejects(
      userAdmin.update({ id: -1 }, deputy.user.id, { role: 'student' }),
      /only active admin/,
    );
    await assert.rejects(
      userAdmin.update({ id: -1 }, deputy.user.id, { isActive: false }),
      /only active admin/,
    );
  });

  test('an admin listed in ADMIN_EMAILS cannot be demoted here', async () => {
    const boss = await agent();
    const reg = await boss.post('/api/auth/register').send({ name: 'Boss', email: 'boss@campus.test', password: PASSWORD });
    assert.equal(reg.body.user.role, 'admin');
    const res = await admin.patch(`/api/admin/users/${reg.body.user.id}`).send({ role: 'student' });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /ADMIN_EMAILS/);
    assert.equal((await admin.get('/api/admin/users?q=boss')).body.users[0].in_admin_emails, true);
  });

  test('deactivating someone with upcoming bookings asks first, then frees the rooms and signs them out', async () => {
    const b = await lecturer.post('/api/bookings').send({
      roomId: await roomId('LT-2'), title: 'Lecture', category: 'lecture', date, start: '08:00', end: '10:00', attendees: 100,
    });
    const ask = await admin.patch(`/api/admin/users/${lecturer.user.id}`).send({ isActive: false });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.upcoming, 1);
    const ok = await admin.patch(`/api/admin/users/${lecturer.user.id}`).send({ isActive: false, cancelUpcoming: true });
    assert.equal(ok.body.cancelled, 1);
    assert.equal((await db.get('SELECT status FROM bookings WHERE id = ?', [b.body.booking.id])).status, 'cancelled');
    assert.equal((await lecturer.get('/api/auth/me')).status, 401);
    assert.equal((await agent().post('/api/auth/login').send({ email: 'amoah@campus.test', password: PASSWORD })).status, 401);
    assert.equal((await admin.get('/api/admin/users?status=inactive')).body.users[0].email, 'amoah@campus.test');
    // Reactivate
    await admin.patch(`/api/admin/users/${lecturer.user.id}`).send({ isActive: true });
    assert.equal((await agent().post('/api/auth/login').send({ email: 'amoah@campus.test', password: PASSWORD })).status, 200);
  });

  test('details can be corrected, and changes are audited', async () => {
    await admin.patch(`/api/admin/users/${student.user.id}`).send({ name: 'Akua Mensah', department: 'Law', indexNumber: '10955556' });
    const u = await db.get('SELECT name, index_number FROM users WHERE id = ?', [student.user.id]);
    assert.deepEqual(u, { name: 'Akua Mensah', index_number: '10955556' });
    await admin.patch(`/api/admin/users/${student.user.id}`).send({ role: 'lecturer' });
    const row = await db.get("SELECT details FROM audit_log WHERE action = 'user.role_change'");
    assert.deepEqual(row.details, { role: 'lecturer', from: 'student' });
  });
});

describe('staff access requests', () => {
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const letter = (buf = PDF, name = 'Offer letter.pdf') => ({ name, type: 'application/pdf', data: buf.toString('base64') });
  let admin; let applicant;

  beforeEach(async () => {
    await resetDb();
    admin = await signedIn('office@campus.test', 'admin');
    applicant = await signedIn('newstaff@campus.test');
  });

  const ask = (who, extra = {}) => who.post('/api/access-requests').send({
    role: 'lecturer', staffId: 'UG/STF/2291', position: 'Lecturer', department: 'Physics', document: letter(), ...extra,
  });

  test('a request with a letter is stored and admins are told', async () => {
    const res = await ask(applicant);
    assert.equal(res.status, 201);
    assert.equal(res.body.request.status, 'pending');
    assert.equal(res.body.request.document_type, 'application/pdf');
    assert.equal(res.body.request.document_sha256.length, 64);
    assert.equal(res.body.request.document, undefined); // the file never comes back to the requester
    assert.equal((await applicant.get('/api/auth/me')).body.user.role, 'student'); // nothing granted yet
    const notes = await admin.get('/api/notifications');
    assert.match(notes.body.notifications[0].message, /asked for lecturer access/);
    const counts = await admin.get('/api/admin/pending-counts');
    assert.deepEqual(counts.body, { bookings: 0, access: 1 });
  });

  test('only real PDF, JPG or PNG files under 3 MB are accepted', async () => {
    const fake = await ask(applicant, { document: letter(Buffer.from('MZ this is an exe'), 'letter.pdf') });
    assert.equal(fake.status, 400);
    assert.match(fake.body.error, /PDF, JPG or PNG/);
    const big = await ask(applicant, { document: letter(Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024)])) });
    assert.equal(big.status, 413);
    const none = await ask(applicant, { document: undefined });
    assert.equal(none.status, 400);
    const png = await ask(applicant, { document: { name: 'scan.png', data: PNG.toString('base64') } });
    assert.equal(png.status, 201);
    assert.equal(png.body.request.document_type, 'image/png');
  });

  test('staff ID and position are required, and only one request can wait at a time', async () => {
    assert.equal((await ask(applicant, { staffId: '' })).status, 400);
    assert.equal((await ask(applicant, { position: '' })).status, 400);
    assert.equal((await ask(applicant, { role: 'student' })).status, 400);
    assert.equal((await ask(applicant)).status, 201);
    const again = await ask(applicant, { role: 'admin' });
    assert.equal(again.status, 409);
  });

  test('admins see the queue and the letter; nobody else can open the letter', async () => {
    const req = (await ask(applicant)).body.request;
    const list = await admin.get('/api/admin/access-requests');
    assert.equal(list.body.requests[0].user_email, 'newstaff@campus.test');
    assert.equal(list.body.requests[0].has_document, true);
    const doc = await admin.get(`/api/admin/access-requests/${req.id}/document`);
    assert.equal(doc.status, 200);
    assert.equal(doc.headers['content-type'], 'application/pdf');
    assert.match(doc.headers['content-disposition'], /^inline; filename\*=UTF-8''Offer%20letter\.pdf/);
    assert.equal(Buffer.from(doc.body).subarray(0, 5).toString(), '%PDF-');
    assert.equal((await applicant.get(`/api/admin/access-requests/${req.id}/document`)).status, 403);
    assert.equal((await agent().get(`/api/admin/access-requests/${req.id}/document`)).status, 401);
  });

  test('approving grants the role at once, tells the person, and deletes the letter', async () => {
    const req = (await ask(applicant)).body.request;
    const ok = await admin.post(`/api/admin/access-requests/${req.id}/approve`);
    assert.equal(ok.status, 200);
    assert.equal((await applicant.get('/api/auth/me')).body.user.role, 'lecturer');
    const notes = await applicant.get('/api/notifications');
    assert.match(notes.body.notifications[0].message, /lecturer access was approved/);
    const row = await db.get('SELECT document, document_sha256 FROM access_requests WHERE id = ?', [req.id]);
    assert.equal(row.document, null);
    assert.equal(row.document_sha256, req.document_sha256); // the fingerprint is kept
    assert.equal((await admin.get(`/api/admin/access-requests/${req.id}/document`)).status, 410);
    const audit = await db.get("SELECT details FROM audit_log WHERE action = 'access.approve'");
    assert.equal(audit.details.letter_sha256, req.document_sha256);
    assert.equal((await admin.post(`/api/admin/access-requests/${req.id}/reject`)).status, 409);
  });

  test('rejecting keeps the role, gives the reason, deletes the letter, and allows a new request', async () => {
    const req = (await ask(applicant, { role: 'admin', position: 'Timetable Officer' })).body.request;
    await admin.post(`/api/admin/access-requests/${req.id}/reject`).send({ reason: 'Please upload a clearer copy' });
    assert.equal((await applicant.get('/api/auth/me')).body.user.role, 'student');
    const mine = await applicant.get('/api/access-requests/mine');
    assert.equal(mine.body.request.status, 'rejected');
    assert.equal(mine.body.request.decision_reason, 'Please upload a clearer copy');
    assert.equal(mine.body.request.has_document, false);
    assert.equal((await ask(applicant, { role: 'admin', position: 'Timetable Officer' })).status, 201);
  });

  test('an admin cannot approve their own request, and students cannot decide', async () => {
    const req = (await ask(applicant)).body.request;
    assert.equal((await applicant.post(`/api/admin/access-requests/${req.id}/approve`)).status, 403);
    // A lecturer asking for admin, who is later made admin by someone else, still can't decide their own request
    await db.run("UPDATE users SET role = 'admin' WHERE id = ?", [applicant.user.id]);
    assert.equal((await applicant.post(`/api/admin/access-requests/${req.id}/approve`)).status, 403);
  });

  test('an older database is upgraded automatically on the next request', async () => {
    const { resetSetupState } = require('../src/db/setup');
    await db.pool.query('DROP TABLE access_requests; DROP TABLE app_meta;');
    resetSetupState();
    const res = await ask(applicant);
    assert.equal(res.status, 201);
    const v = await db.get("SELECT value FROM app_meta WHERE key = 'schema_version'");
    assert.equal(v.value, String(require('../src/db/setup').SCHEMA_VERSION));
  });
});

describe('passwords', () => {
  let admin; let person;

  beforeEach(async () => {
    await resetDb();
    admin = await signedIn('desk@campus.test', 'admin');
    person = await signedIn('ama.forgot@campus.test');
  });

  const login = (email, password) => {
    const a = agent();
    return a.post('/api/auth/login').send({ email, password }).then((res) => Object.assign(a, { res }));
  };

  test('temporary passwords are 12 easy-to-read characters', () => {
    const { temporaryPassword } = require('../src/services/userAdmin');
    for (let i = 0; i < 50; i++) assert.match(temporaryPassword(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  });

  test('admin reset: old password stops working, temporary one works once, then a new password is required', async () => {
    const reset = await admin.post(`/api/admin/users/${person.user.id}/reset-password`);
    assert.equal(reset.status, 200);
    const temp = reset.body.temporaryPassword;
    assert.ok(new Date(reset.body.expiresAt) > new Date(Date.now() + 71 * 3600e3));

    // Signed out everywhere, old password dead
    assert.equal((await person.get('/api/auth/me')).status, 401);
    assert.equal((await login('ama.forgot@campus.test', PASSWORD)).res.status, 401);

    // Temporary password signs in, but only the password change is allowed
    const t = await login('ama.forgot@campus.test', temp);
    assert.equal(t.res.status, 200);
    assert.equal(t.res.body.user.mustChangePassword, true);
    const blocked = await t.get('/api/bookings/mine');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.mustChangePassword, true);
    assert.equal((await t.get('/api/auth/me')).status, 200);

    // Choose a new one
    const weak = await t.post('/api/auth/change-password').send({ currentPassword: temp, newPassword: 'short' });
    assert.equal(weak.status, 400);
    const ok = await t.post('/api/auth/change-password').send({ currentPassword: temp, newPassword: 'MyOwnPass9' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.mustChangePassword, false);
    assert.equal((await t.get('/api/bookings/mine')).status, 200); // same session carries on
    assert.equal((await login('ama.forgot@campus.test', temp)).res.status, 401); // temp is dead
    assert.equal((await login('ama.forgot@campus.test', 'MyOwnPass9')).res.status, 200);

    // The person is told, and it's audited without the password
    const notes = await t.get('/api/notifications');
    assert.ok(notes.body.notifications.some((n) => /password was reset by the timetable office/.test(n.message)));
    const row = await db.get("SELECT details FROM audit_log WHERE action = 'user.reset_password'");
    assert.equal(row.details, null);
    const stored = await db.get('SELECT password_hash FROM users WHERE id = ?', [person.user.id]);
    assert.ok(!stored.password_hash.includes(temp));
  });

  test('a temporary password expires after 72 hours', async () => {
    const { body } = await admin.post(`/api/admin/users/${person.user.id}/reset-password`);
    await db.run("UPDATE users SET temp_password_expires_at = now() - interval '1 minute' WHERE id = ?", [person.user.id]);
    const res = (await login('ama.forgot@campus.test', body.temporaryPassword)).res;
    assert.equal(res.status, 401);
    assert.match(res.body.error, /expired/);
  });

  test('only admins can reset, and not their own password', async () => {
    assert.equal((await person.post(`/api/admin/users/${admin.user.id}/reset-password`)).status, 403);
    assert.equal((await admin.post(`/api/admin/users/${admin.user.id}/reset-password`)).status, 403);
  });

  test('changing your own password signs out your other devices but keeps this one', async () => {
    const other = await login('ama.forgot@campus.test', PASSWORD);
    const wrong = await person.post('/api/auth/change-password').send({ currentPassword: 'Nope12345', newPassword: 'Another99' });
    assert.equal(wrong.status, 400);
    const same = await person.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: PASSWORD });
    assert.equal(same.status, 400);
    const ok = await person.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'Another99' });
    assert.equal(ok.status, 200);
    assert.equal((await person.get('/api/auth/me')).status, 200);
    assert.equal((await other.get('/api/auth/me')).status, 401);
  });

  test('forgot password without email set up: same answer for any email, admins told at most once an hour, flag shown until reset', async () => {
    const mail = require('../src/services/mail');
    mail.setModeForTests(null);
    try {
    const known = await agent().post('/api/auth/forgot-password').send({ email: 'AMA.FORGOT@campus.test' });
    const unknown = await agent().post('/api/auth/forgot-password').send({ email: 'nobody@campus.test' });
    assert.equal(known.status, 200);
    assert.deepEqual(known.body, unknown.body);
    await agent().post('/api/auth/forgot-password').send({ email: 'ama.forgot@campus.test' });
    const notes = (await admin.get('/api/notifications')).body.notifications.filter((n) => /forgotten their password/.test(n.message));
    assert.equal(notes.length, 1);

    const before = (await admin.get('/api/admin/users?q=ama.forgot')).body.users[0];
    assert.ok(before.reset_requested_at);
    await admin.post(`/api/admin/users/${person.user.id}/reset-password`);
    const after = (await admin.get('/api/admin/users?q=ama.forgot')).body.users[0];
    assert.equal(after.reset_requested_at, null);
    assert.equal(after.must_change_password, true);
    } finally {
      mail.setModeForTests(undefined);
    }
  });

  test('sessions from before this release keep working', async () => {
    const jwt = require('jsonwebtoken');
    const config = require('../src/config');
    const old = jwt.sign({ sub: person.user.id }, config.jwtSecret, { expiresIn: 600 }); // no "v"
    const res = await request(app).get('/api/auth/me').set('Cookie', `token=${old}`).set('X-Requested-With', 'XMLHttpRequest');
    assert.equal(res.status, 200);
  });
});

describe('statistics', () => {
  let admin; let lecturer; let student;
  // A fixed past Monday–Sunday week, so the numbers are exact.
  const monday = '2026-10-05';
  const day = (n) => addDays(monday, n);

  beforeEach(async () => {
    await resetDb();
    admin = await signedIn('stats@campus.test', 'admin');
    lecturer = await signedIn('kumi@campus.test', 'lecturer');
    student = await signedIn('yaa@campus.test');
    const add = async (code, who, date, start, end, status, extra = {}) => db.run(
      `INSERT INTO bookings (room_id, user_id, title, category, date, start_time, end_time, attendees, status, decided_by, created_at, updated_at)
       VALUES (?, ?, 'X', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [await roomId(code), who, extra.category || 'lecture', date, start, end, extra.attendees || 10, status,
        extra.decidedBy || null, extra.created || `${date} 08:00`, extra.updated || `${date} 08:00`],
    );
    // LT-1: 2 h Monday + 3 h Wednesday; LT-2: 1 h Monday 09:30–10:30 (spans two clock hours)
    await add('LT-1', lecturer.user.id, day(0), '08:00', '10:00', 'approved', { attendees: 150 });
    await add('LT-1', lecturer.user.id, day(2), '09:00', '12:00', 'approved');
    await add('LT-2', admin.user.id, day(0), '09:30', '10:30', 'approved', { category: 'exam' });
    // Student requests: one approved after 4 h, one rejected after 2 h, one waiting; plus a cancellation
    await add('LIB-S1', student.user.id, day(1), '10:00', '11:00', 'approved',
      { category: 'study', decidedBy: admin.user.id, created: `${day(0)} 08:00`, updated: `${day(0)} 12:00` });
    await add('LIB-S2', student.user.id, day(1), '10:00', '11:00', 'rejected',
      { category: 'study', decidedBy: admin.user.id, created: `${day(0)} 08:00`, updated: `${day(0)} 10:00` });
    await add('LIB-S3', student.user.id, day(3), '10:00', '11:00', 'pending', { category: 'study' });
    await add('LT-3', lecturer.user.id, day(4), '10:00', '11:00', 'cancelled');
    // Outside the range: must not count
    await add('LT-1', lecturer.user.id, day(9), '08:00', '12:00', 'approved');
  });

  const get = (q) => admin.get(`/api/admin/stats?from=${monday}&to=${day(6)}${q || ''}`);

  test('only admins can see statistics', async () => {
    assert.equal((await lecturer.get('/api/admin/stats')).status, 403);
  });

  test('headline numbers and utilisation over teaching days', async () => {
    const { body } = await get();
    assert.equal(body.range.days, 7);
    assert.equal(body.range.teachingDays, 5);
    assert.equal(body.current.bookings, 4);              // approved only
    assert.equal(body.current.hours, 7);                 // 2 + 3 + 1 + 1
    assert.equal(body.current.cancelled, 1);
    // 16 rooms × 5 days × 14 h = 1120 h available
    assert.ok(Math.abs(body.current.utilisation - 7 / 1120) < 1e-9);
  });

  test('per-room utilisation, ranked, with average fill', async () => {
    const { body } = await get();
    assert.equal(body.rooms.length, 16);
    assert.equal(body.rooms[0].code, 'LT-1');
    assert.equal(body.rooms[0].hours, 5);
    assert.ok(Math.abs(body.rooms[0].utilisation - 5 / 70) < 1e-9); // 5 days × 14 h
    assert.equal(body.rooms[0].avg_fill, Math.round(((150 + 10) / 2 / 300) * 100) / 100);
    assert.equal(body.rooms.find((r) => r.code === 'NAB-206').hours, 0);
  });

  test('busiest hours split bookings across clock hours', async () => {
    const { body } = await get();
    assert.equal(body.hours.length, 14);
    assert.deepEqual(body.hours.map((h) => h.hour), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const at = (h) => body.hours.find((x) => x.hour === h).hours;
    assert.equal(at(8), 1);      // LT-1 Mon 08–09
    assert.equal(at(9), 2.5);    // LT-1 Mon 09–10, LT-1 Wed 09–10, LT-2 09:30–10:00
    assert.equal(at(10), 2.5);   // LT-2 Mon 10:00–10:30, LT-1 Wed 10–11, LIB-S1 Tue 10–11 (rejected/pending don't count)
    assert.equal(at(11), 1);     // LT-1 Wed 11–12
    assert.equal(at(7), 0);
  });

  test('categories and student requests', async () => {
    const { body } = await get();
    assert.deepEqual(body.categories.map((c) => [c.category, c.hours]), [['lecture', 5], ['exam', 1], ['study', 1]]);
    assert.deepEqual(body.requests, { total: 3, pending: 1, approved: 1, rejected: 1, medianDecisionHours: 3 });
  });

  test('comparison with the previous period and a building filter', async () => {
    const { body } = await get();
    assert.equal(body.previousRange.to, addDays(monday, -1));
    assert.equal(body.previous.bookings, 0);
    const ltb = (await db.get("SELECT id FROM buildings WHERE code = 'LTB'")).id;
    const only = (await get(`&buildingId=${ltb}`)).body;
    assert.equal(only.rooms.length, 3);
    assert.equal(only.current.hours, 6);
    assert.equal(only.categories.find((c) => c.category === 'study'), undefined);
  });

  test('bad ranges are refused', async () => {
    assert.equal((await admin.get('/api/admin/stats?from=2026-10-10&to=2026-10-01')).status, 400);
    assert.equal((await admin.get('/api/admin/stats?from=2024-01-01&to=2026-01-01')).status, 400);
    assert.equal((await admin.get('/api/admin/stats?from=nope')).status, 400);
  });
});

describe('room week', () => {
  let lecturer; let student;
  beforeEach(async () => {
    await resetDb();
    lecturer = await signedIn('wk.lecturer@campus.test', 'lecturer');
    student = await signedIn('wk.student@campus.test');
  });

  test('returns Monday to Sunday around any date, with your own bookings marked', async () => {
    const date = tomorrow();
    await lecturer.post('/api/bookings').send({ roomId: await roomId('LT-2'), title: 'Mine', category: 'lecture', date, start: '09:00', end: '11:00', attendees: 40 });
    const res = await lecturer.get(`/api/rooms/${await roomId('LT-2')}/week?date=${date}`);
    assert.equal(res.status, 200);
    assert.equal(new Date(`${res.body.from}T00:00:00Z`).getUTCDay(), 1); // Monday
    assert.equal(addDays(res.body.from, 6), res.body.to);
    assert.ok(res.body.from <= date && date <= res.body.to);
    assert.equal(res.body.bookings.length, 1);
    assert.equal(res.body.bookings[0].mine, true);
    assert.equal(res.body.bookings[0].user_id, undefined);
    assert.equal(res.body.room.canBook, true);
    // A student sees the same timetable but can't book a lecture hall, and it isn't marked theirs
    const s = await student.get(`/api/rooms/${await roomId('LT-2')}/week?date=${date}`);
    assert.equal(s.body.room.canBook, false);
    assert.equal(s.body.bookings[0].mine, false);
    assert.equal((await student.get(`/api/rooms/${await roomId('LT-2')}/week?date=13-11-2026`)).status, 400);
  });

  test('a Sunday belongs to the week that started the Monday before', async () => {
    const res = await lecturer.get(`/api/rooms/${await roomId('LT-1')}/week?date=2026-11-15`);
    assert.deepEqual([res.body.from, res.body.to], ['2026-11-09', '2026-11-15']);
  });
});

describe('weekly bookings', () => {
  let lecturer; let other; let student; let admin;
  const first = tomorrow();
  const week = (n) => addDays(first, 7 * n);
  const body = (extra = {}) => ({
    roomId: null, title: 'Algorithms', category: 'lecture', courseCode: 'csc 302', date: first,
    start: '09:00', end: '11:00', attendees: 80, weeks: 4, ...extra,
  });

  beforeEach(async () => {
    await resetDb();
    lecturer = await signedIn('weekly@campus.test', 'lecturer');
    other = await signedIn('other.lect@campus.test', 'lecturer');
    student = await signedIn('weekly.student@campus.test');
    admin = await signedIn('weekly.admin@campus.test', 'admin');
  });

  test('preview shows every week; a clash in week 3 is named', async () => {
    const room = await roomId('LT-2');
    await other.post('/api/bookings').send({ roomId: room, title: 'Exam', category: 'exam', courseCode: 'MATH 101',
      date: week(2), start: '10:00', end: '12:00', attendees: 100 });
    const res = await lecturer.post('/api/bookings/series/preview').send(body({ roomId: room }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.dates.map((d) => d.date), [week(0), week(1), week(2), week(3)]);
    assert.deepEqual(res.body.dates.map((d) => d.ok), [true, true, false, true]);
    assert.match(res.body.dates[2].reason, /LT-2 is taken 10:00–12:00 by MATH 101/);
    assert.equal(await db.get('SELECT count(*)::int AS n FROM bookings WHERE user_id = ?', [lecturer.user.id]).then((r) => r.n), 0);
  });

  test('with a clash, nothing is booked unless you choose to skip it', async () => {
    const room = await roomId('LT-2');
    await other.post('/api/bookings').send({ roomId: room, title: 'Exam', category: 'exam', date: week(2), start: '10:00', end: '12:00', attendees: 100 });
    const refused = await lecturer.post('/api/bookings/series').send(body({ roomId: room }));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.dates.length, 4);
    assert.equal(await db.get('SELECT count(*)::int AS n FROM bookings WHERE user_id = ?', [lecturer.user.id]).then((r) => r.n), 0);

    const ok = await lecturer.post('/api/bookings/series').send(body({ roomId: room, skipClashes: true }));
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.booked, [week(0), week(1), week(3)]);
    assert.deepEqual(ok.body.skipped.map((s) => s.date), [week(2)]);
    const rows = await db.all('SELECT date, status, series_id, course_code FROM bookings WHERE user_id = ? ORDER BY date', [lecturer.user.id]);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.status === 'approved' && r.series_id === ok.body.seriesId && r.course_code === 'CSC 302'));
    const series = await db.get('SELECT weekday, first_date, last_date FROM booking_series WHERE id = ?', [ok.body.seriesId]);
    assert.deepEqual([series.first_date, series.last_date], [week(0), week(3)]);
    assert.equal(series.weekday, new Date(`${first}T00:00:00Z`).getUTCDay());
  });

  test('your own other bookings count as clashes too', async () => {
    await lecturer.post('/api/bookings').send({ roomId: await roomId('LT-1'), title: 'Other', category: 'lecture', date: week(1), start: '10:00', end: '11:00', attendees: 50 });
    const res = await lecturer.post('/api/bookings/series/preview').send(body({ roomId: await roomId('LT-3') }));
    assert.equal(res.body.dates[1].clash, 'user');
    assert.match(res.body.dates[1].reason, /You are booked in LT-1/);
  });

  test('students cannot book weekly; weeks must be 2–16; dates past 150 days are refused per week', async () => {
    const room = await roomId('LIB-S1');
    const s = await student.post('/api/bookings/series/preview').send(body({ roomId: room, category: 'study', attendees: 3 }));
    assert.equal(s.status, 403);
    assert.equal((await lecturer.post('/api/bookings/series/preview').send(body({ roomId: room, weeks: 1, attendees: 3 }))).status, 400);
    assert.equal((await lecturer.post('/api/bookings/series/preview').send(body({ roomId: room, weeks: 17, attendees: 3 }))).status, 400);
    const far = await lecturer.post('/api/bookings/series/preview').send(body({ roomId: room, attendees: 3, date: addDays(localDate(), 140), weeks: 3 }));
    assert.deepEqual(far.body.dates.map((d) => d.ok), [true, true, false]);
    assert.match(far.body.dates[2].reason, /150 days/);
  });

  test('cancelling a series cancels the weeks still to come; an admin doing it tells the owner', async () => {
    const created = await lecturer.post('/api/bookings/series').send(body({ roomId: await roomId('LT-3') }));
    // One week cancelled on its own first
    const one = await db.get('SELECT id FROM bookings WHERE series_id = ? AND date = ?', [created.body.seriesId, week(1)]);
    await lecturer.post(`/api/bookings/${one.id}/cancel`);
    assert.equal((await other.post(`/api/bookings/series/${created.body.seriesId}/cancel`)).status, 404);
    const res = await admin.post(`/api/bookings/series/${created.body.seriesId}/cancel`);
    assert.equal(res.body.cancelled, 3);
    const left = await db.get("SELECT count(*)::int AS n FROM bookings WHERE series_id = ? AND status = 'approved'", [created.body.seriesId]);
    assert.equal(left.n, 0);
    const notes = await lecturer.get('/api/notifications');
    assert.match(notes.body.notifications[0].message, /cancelled the remaining 3 weeks of your weekly booking in LT-3/);
    assert.equal((await lecturer.post(`/api/bookings/series/${created.body.seriesId}/cancel`)).status, 400);
  });
});

describe('audit log', () => {
  let admin; let lecturer; let student;
  beforeEach(async () => {
    await resetDb();
    admin = await signedIn('auditor@campus.test', 'admin');
    lecturer = await signedIn('logged.lect@campus.test', 'lecturer');
    student = await signedIn('logged.student@campus.test');
  });

  test('only admins can read it', async () => {
    assert.equal((await lecturer.get('/api/admin/audit')).status, 403);
    assert.equal((await student.get('/api/admin/audit.csv')).status, 403);
  });

  test('entries read as sentences, newest first', async () => {
    const date = tomorrow();
    const req = await student.post('/api/bookings').send({ roomId: await roomId('LIB-S1'), title: 'Revision', category: 'study', date, start: '10:00', end: '11:00', attendees: 3 });
    await admin.post(`/api/admin/bookings/${req.body.booking.id}/reject`).send({ reason: 'Exams' });
    await agent().post('/api/auth/login').send({ email: 'logged.student@campus.test', password: 'wrong-pass1' });
    const { body } = await admin.get('/api/admin/audit');
    const s = body.entries.map((e) => e.summary);
    assert.equal(s[0], "Failed sign-in to logged.student's account");
    assert.match(s[1], /^auditor rejected logged\.student's request for LIB-S1 on .+ at 10:00$/);
    assert.equal(body.entries[1].detail, '“Exams”');
    assert.match(s[2], /^logged\.student booked LIB-S1 on .+ at 10:00$/);
    assert.equal(body.entries[2].detail, 'request, awaiting approval');
    assert.ok(s.includes('auditor created an account'));
  });

  test('filters: security, a person, dates; and "load older"', async () => {
    await lecturer.post('/api/bookings').send({ roomId: await roomId('LT-2'), title: 'X', category: 'lecture', date: tomorrow(), start: '08:00', end: '09:00', attendees: 10 });
    await agent().post('/api/auth/login').send({ email: 'nobody@campus.test', password: 'wrong-pass1' });
    const security = (await admin.get('/api/admin/audit?group=security')).body.entries;
    assert.ok(security.every((e) => e.action.startsWith('auth.') || e.action.startsWith('user.') || e.action.startsWith('access.')));
    const failed = await admin.get('/api/admin/audit?group=failed');
    assert.deepEqual(failed.body.entries.map((e) => e.action), ['auth.login_failed']);
    assert.equal(failed.body.security.failed_24h, 1);
    const bookings = (await admin.get('/api/admin/audit?group=bookings&q=LOGGED.LECT')).body.entries;
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].action, 'booking.create');
    const byEmail = (await admin.get('/api/admin/audit?q=nobody@campus')).body.entries;
    assert.equal(byEmail.length, 1);
    assert.equal(byEmail[0].summary, 'Failed sign-in for an unknown email');
    assert.equal(byEmail[0].detail, 'tried nobody@campus.test');
    const today = localDate();
    assert.ok((await admin.get(`/api/admin/audit?from=${today}&to=${today}`)).body.entries.length > 0);
    assert.equal((await admin.get(`/api/admin/audit?to=${addDays(today, -1)}`)).body.entries.length, 0);
    // Paging
    const all = (await admin.get('/api/admin/audit')).body.entries;
    const { body } = await request(app).get('/api/admin/audit').set('Cookie', '').set('X-Requested-With', 'XMLHttpRequest');
    assert.equal(body.error, 'Please sign in');
    const older = (await admin.get(`/api/admin/audit?before=${all[1].id}`)).body.entries;
    assert.equal(older[0].id, all[2].id);
    assert.equal((await admin.get('/api/admin/audit?group=nonsense')).status, 400);
  });

  test('the log cannot be changed or deleted, even directly in the database', async () => {
    const row = await db.get('SELECT id FROM audit_log ORDER BY id LIMIT 1');
    await assert.rejects(db.run("UPDATE audit_log SET action = 'edited' WHERE id = ?", [row.id]), /cannot be changed or deleted/);
    await assert.rejects(db.run('DELETE FROM audit_log WHERE id = ?', [row.id]), /cannot be changed or deleted/);
    assert.ok(await db.get('SELECT id FROM audit_log WHERE id = ?', [row.id]));
  });

  test('CSV export matches the page', async () => {
    await student.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'NewPass123' });
    const res = await admin.get('/api/admin/audit.csv?group=security');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment; filename="audit-log_/);
    const lines = res.text.replace(/^﻿/, '').split('\r\n');
    assert.match(lines[0], /^"Time \(Accra\)","Who","Email"/);
    assert.match(lines[1], /"logged\.student changed their password"/);
  });
});

describe('calendar export', () => {
  let lecturer; let student; let admin;
  const date = tomorrow();
  beforeEach(async () => {
    await resetDb();
    lecturer = await signedIn('cal.lect@campus.test', 'lecturer');
    student = await signedIn('cal.student@campus.test');
    admin = await signedIn('cal.admin@campus.test', 'admin');
  });
  const text = (res) => (typeof res.text === 'string' ? res.text : Buffer.from(res.body).toString('utf8'));
  const book = (who, code, extra = {}) => roomId(code).then((id) => who.post('/api/bookings').send({
    roomId: id, title: 'Operating Systems', category: 'lecture', courseCode: 'CSC 301', date, start: '09:00', end: '11:00', attendees: 50, ...extra,
  }));

  test('download: upcoming approved and pending bookings, as an .ics attachment', async () => {
    const mine = await book(lecturer, 'LT-1');
    await book(lecturer, 'LT-2', { start: '13:00', end: '14:00', title: 'Gone' }).then((r) => lecturer.post(`/api/bookings/${r.body.booking.id}/cancel`));
    const res = await lecturer.get('/api/bookings/mine.ics');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/calendar/);
    assert.match(res.headers['content-disposition'], /attachment; filename="my-room-bookings.ics"/);
    const body = text(res);
    assert.equal((body.match(/BEGIN:VEVENT/g) || []).length, 1); // the cancelled one is left out
    assert.match(body, new RegExp(`UID:booking-${mine.body.booking.id}@lecture-rooms`));
    assert.match(body, /SUMMARY:CSC 301 · Operating Systems \(LT-1\)/);
    assert.match(body, /LOCATION:LT-1\\, Lecture Theatre 1\\, Lecture Theatre Block/);
    assert.match(body, /STATUS:CONFIRMED/);
  });

  test('a student request shows as tentative, awaiting approval', async () => {
    await book(student, 'LIB-S1', { category: 'study', attendees: 3, courseCode: '' });
    const body = text(await student.get('/api/bookings/mine.ics'));
    assert.match(body, /STATUS:TENTATIVE/);
    assert.match(body, /SUMMARY:\[Awaiting approval\] Operating Systems \(LIB-S1\)/);
  });

  test("one booking's file: yours, or any for an admin, nobody else's", async () => {
    const b = (await book(lecturer, 'LT-1')).body.booking;
    const own = await lecturer.get(`/api/bookings/${b.id}/calendar.ics`);
    assert.equal(own.status, 200);
    assert.match(own.headers['content-disposition'], new RegExp(`LT-1_${date}\\.ics`));
    assert.equal((await student.get(`/api/bookings/${b.id}/calendar.ics`)).status, 404);
    assert.equal((await admin.get(`/api/bookings/${b.id}/calendar.ics`)).status, 200);
  });

  test('subscription: works without signing in, shows cancellations, and is stored only as a hash', async () => {
    const b = (await book(lecturer, 'LT-1')).body.booking;
    assert.deepEqual((await lecturer.get('/api/calendar/status')).body, { hasFeed: false, createdAt: null });
    const link = (await lecturer.post('/api/calendar/feed')).body;
    assert.match(link.url, /\/api\/calendar\/feed\/[A-Za-z0-9_-]{43}\.ics$/);
    assert.match(link.webcal, /^webcal:/);
    assert.match(link.google, /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal/);
    const token = link.url.match(/feed\/([^.]+)\.ics/)[1];
    const stored = await db.get('SELECT calendar_token_hash FROM users WHERE id = ?', [lecturer.user.id]);
    assert.notEqual(stored.calendar_token_hash, token);
    assert.equal(stored.calendar_token_hash.length, 64);

    const path = new URL(link.url).pathname;
    const feed = await request(app).get(path); // no cookie, no CSRF header: like a calendar app
    assert.equal(feed.status, 200);
    assert.match(feed.headers['content-type'], /^text\/calendar/);
    assert.match(text(feed), /STATUS:CONFIRMED/);
    await lecturer.post(`/api/bookings/${b.id}/cancel`);
    assert.match(text(await request(app).get(path)), /STATUS:CANCELLED/); // so calendars remove it
    assert.equal((await lecturer.get('/api/calendar/status')).body.hasFeed, true);
  });

  test('replacing or turning off the link stops the old one; bad tokens and deactivated accounts get 404', async () => {
    const first = new URL((await lecturer.post('/api/calendar/feed')).body.url).pathname;
    const second = new URL((await lecturer.post('/api/calendar/feed')).body.url).pathname;
    assert.equal((await request(app).get(first)).status, 404);
    assert.equal((await request(app).get(second)).status, 200);
    await db.run('UPDATE users SET is_active = false WHERE id = ?', [lecturer.user.id]);
    assert.equal((await request(app).get(second)).status, 404);
    await db.run('UPDATE users SET is_active = true WHERE id = ?', [lecturer.user.id]);
    await lecturer.delete('/api/calendar/feed');
    assert.equal((await request(app).get(second)).status, 404);
    assert.equal((await request(app).get('/api/calendar/feed/short.ics')).status, 404);
    const actions = (await db.all("SELECT action FROM audit_log WHERE action LIKE 'calendar.%' ORDER BY id")).map((r) => r.action);
    assert.deepEqual(actions, ['calendar.create_link', 'calendar.replace_link', 'calendar.remove_link']);
  });
});

describe('password reset by emailed code', () => {
  const mail = require('../src/services/mail');
  const EMAIL = 'otp.person@campus.test';
  let person;

  beforeEach(async () => {
    await resetDb();
    mail.outbox.length = 0;
    person = await signedIn(EMAIL);
  });

  const ask = (email = EMAIL) => agent().post('/api/auth/forgot-password').send({ email });
  const codeFromMail = () => {
    const m = mail.outbox.at(-1);
    return m && m.text.match(/code is (\d{3}) (\d{3})/).slice(1).join('');
  };
  const reset = (code, newPassword = 'Brand9New') => {
    const a = agent();
    return a.post('/api/auth/reset-password').send({ email: EMAIL, code, newPassword }).then((res) => Object.assign(a, { res }));
  };
  const backdate = (seconds) => db.pool.query(`UPDATE password_resets SET created_at = created_at - interval '${seconds} seconds'`);

  test('codes are 6 digits', () => {
    const { newCode } = require('../src/services/passwordReset');
    for (let i = 0; i < 200; i++) assert.match(newCode(), /^\d{6}$/);
  });

  test('a code is emailed; the reply is the same for unknown emails', async () => {
    const known = await ask('OTP.Person@campus.test');
    const unknown = await ask('nobody@campus.test');
    assert.deepEqual(known.body, { ok: true, method: 'code', minutes: 10 });
    assert.deepEqual(unknown.body, known.body);
    assert.equal(mail.outbox.length, 1);
    assert.equal(mail.outbox[0].to, EMAIL);
    assert.match(mail.outbox[0].subject, /^Your Lecture Rooms code: \d{3} \d{3}$/);
    assert.match(mail.outbox[0].html, /\d{3} \d{3}/);
    // Only a keyed hash is stored
    const row = await db.get('SELECT code_hash FROM password_resets');
    assert.equal(row.code_hash.length, 64);
    assert.ok(!row.code_hash.includes(codeFromMail()));
  });

  test('the right code sets the new password, signs you in, and signs out other devices', async () => {
    await ask();
    const r = await reset(codeFromMail());
    assert.equal(r.res.status, 200);
    assert.equal(r.res.body.user.email, EMAIL);
    assert.equal((await r.get('/api/auth/me')).status, 200);
    assert.equal((await person.get('/api/auth/me')).status, 401); // the old session is gone
    assert.equal((await agent().post('/api/auth/login').send({ email: EMAIL, password: PASSWORD })).status, 401);
    assert.equal((await agent().post('/api/auth/login').send({ email: EMAIL, password: 'Brand9New' })).status, 200);
    const notes = await r.get('/api/notifications');
    assert.match(notes.body.notifications[0].message, /changed using a code sent to your email/);
    // A code works once
    assert.equal((await reset(codeFromMail(), 'Another9x')).res.status, 400);
  });

  test('spaces in the code are fine; weak passwords are refused without using up the code', async () => {
    await ask();
    const code = codeFromMail();
    assert.equal((await reset(code, 'weak')).res.status, 400);
    assert.equal((await reset(`${code.slice(0, 3)} ${code.slice(3)}`)).res.status, 200);
  });

  test('five wrong codes use it up', async () => {
    await ask();
    const right = codeFromMail();
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) {
      const r = await reset(wrong);
      assert.equal(r.res.status, 400);
      assert.match(r.res.body.error, /wrong or has expired/);
    }
    assert.match((await reset(wrong)).res.body.error, /Too many wrong codes/);
    assert.equal((await reset(right)).res.status, 400); // even the right one no longer works
    const { attempts } = await db.get('SELECT attempts FROM password_resets');
    assert.equal(attempts, 5);
  });

  test('codes expire after 10 minutes', async () => {
    await ask();
    await db.pool.query("UPDATE password_resets SET expires_at = now() - interval '1 second'");
    assert.equal((await reset(codeFromMail())).res.status, 400);
  });

  test('only the newest code works; at most one a minute and five an hour', async () => {
    await ask();
    const first = codeFromMail();
    await ask(); // too soon: nothing sent
    assert.equal(mail.outbox.length, 1);
    await backdate(61);
    await ask();
    assert.equal(mail.outbox.length, 2);
    const second = codeFromMail();
    if (first !== second) assert.equal((await reset(first)).res.status, 400);
    for (let i = 0; i < 3; i++) { await backdate(61); await ask(); }
    assert.equal(mail.outbox.length, 5);
    await backdate(61);
    await ask(); // sixth in the hour: refused quietly
    assert.equal(mail.outbox.length, 5);
    assert.equal((await reset(codeFromMail())).res.status, 200);
  });

  test('deactivated accounts get no code', async () => {
    await db.run('UPDATE users SET is_active = false WHERE id = ?', [person.user.id]);
    await ask();
    assert.equal(mail.outbox.length, 0);
  });

  test('the audit log records sent, wrong and used codes, never the code', async () => {
    await ask();
    await reset('123456' === codeFromMail() ? '654321' : '123456');
    await reset(codeFromMail());
    const rows = await db.all("SELECT action, details FROM audit_log WHERE action LIKE 'auth.reset%' ORDER BY id");
    assert.deepEqual(rows.map((r) => r.action), ['auth.reset_code_sent', 'auth.reset_code_wrong', 'auth.reset_with_code']);
    assert.ok(!JSON.stringify(rows).includes(codeFromMail()));
  });
});
