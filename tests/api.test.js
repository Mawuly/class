'use strict';
const { test, before, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { db, agent, signedIn, resetDb, roomId, tomorrow, PASSWORD } = require('./helpers');
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
    await db.pool.query(`DROP TABLE IF EXISTS audit_log, notifications, bookings, booking_series, rooms, buildings, users CASCADE`);
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
    await db.pool.query(`DROP TABLE IF EXISTS audit_log, notifications, bookings, booking_series, rooms, buildings, users CASCADE`);
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
