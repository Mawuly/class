'use strict';
const { test, before, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { db, agent, signedIn, resetDb, roomId, tomorrow, PASSWORD } = require('./helpers');

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
