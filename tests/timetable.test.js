'use strict';
const { test, before, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { db, agent, signedIn, resetDb, roomId, tomorrow } = require('./helpers');
const tt = require('../src/services/timetable');
const { localDate, localTime, addDays, fromMinutes, toMinutes } = require('../src/utils/time');

before(resetDb);
after(() => db.pool.end());

// A Monday at least a week ahead, so every date in the tests is in the future.
function nextMonday() {
  let d = addDays(localDate(), 7);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
}
const TABLE = `Day,Start,End,Code,Title,Room,Lecturer
Monday,9:30 AM,11:30 AM,ADM301,International Business,LT-1,Dr. Mark Bigool
,1:30 PM,2:30 PM,SBU307,Intro to Cost & Management Accounting,—,Patrick Darkwa
Thursday,12:30 PM,2:30 PM,SBU301,Operations Management,"Lecture Theatre (LT 2)",Priscilla Oppong
Friday,8:30 AM,10:30 AM,SBU305,Managerial Economics,SRT 1,Dr. Emmanuel Kwakye Amoah
Monday,9:30 AM,11:30 AM,MAT201,Calculus,LT-2,Dr. A. Mensah`;

describe('reading a timetable', () => {
  test('times, rows and room names as timetables write them', () => {
    assert.equal(tt.parseTime('9:30 AM'), '09:30');
    assert.equal(tt.parseTime('12:30 pm'), '12:30');
    assert.equal(tt.parseTime('12:00 AM'), '00:00');
    assert.equal(tt.parseTime('18:30'), '18:30');
    assert.equal(tt.parseTime('noonish'), null);
    assert.ok(tt.roomCandidates('New Lecture Theater (NLT 10)').includes('NLT-10'));
    assert.ok(tt.roomCandidates('SWLT 17').includes('SW-17'));
    assert.ok(tt.roomCandidates('C.A. Ackah Lecture Complex (CALC 2)').includes('CAC-2'));
    assert.ok(tt.roomCandidates('LLT').includes('LLT'));
    const rows = tt.parseTable('Day\tTime\tCode\tTitle\tRoom\nTuesday\t8:30 AM – 10:30 AM\tX1\tThing\tLT-1\n\t11:30 AM – 12:30 PM\tX2\tOther\tLT-2');
    assert.deepEqual(rows.map((r) => [r.day, r.start, r.end, r.code]), [[2, '08:30', '10:30', 'X1'], [2, '11:30', '12:30', 'X2']]);
    assert.throws(() => tt.parseTable('Code,Title\nX,Y'), /needs Day, Room/);
  });
});

describe('importing a timetable', () => {
  let admin; let from; let to;
  beforeEach(async () => {
    await resetDb();
    admin = await signedIn('boss@campus.test');
    from = nextMonday();
    to = addDays(from, 7 * 4 - 1); // four weeks
  });

  test('preview: weeks per class, and what cannot be booked, without booking anything', async () => {
    const lecturer = await signedIn('ama@campus.test', 'lecturer');
    await lecturer.post('/api/bookings').send({ roomId: await roomId('LT-2'), title: 'Exam', category: 'exam', date: addDays(from, 3), start: '13:00', end: '14:00', attendees: 50 });
    const res = await admin.post('/api/admin/timetables/preview').send({ label: 'B.Com Management L300', from, to, table: TABLE });
    assert.equal(res.status, 200);
    const [adm, cost, ops, econ, mat] = res.body.rows;
    assert.deepEqual([adm.room, adm.weeks, adm.problem], ['LT-1', 4, null]);
    assert.equal(cost.problem, 'No room given');
    assert.equal(cost.day, 'Monday', 'an empty day repeats the row above');
    assert.deepEqual([ops.room, ops.weeks, ops.skipped.length], ['LT-2', 3, 1]);
    assert.match(ops.skipped[0].reason, /LT-2 has Exam 13:00–14:00/);
    assert.match(econ.problem, /No room "SRT 1"/);
    assert.deepEqual([mat.room, mat.weeks], ['LT-2', 4], 'parallel classes in other rooms are fine');
    assert.equal((await db.get("SELECT count(*)::int AS n FROM bookings WHERE kind = 'timetable'")).n, 0);
  });

  test('import books every free week as approved lectures; it can be removed again', async () => {
    const res = await admin.post('/api/admin/timetables').send({ label: 'B.Com Management L300', from, to, table: TABLE });
    assert.equal(res.status, 201);
    assert.deepEqual([res.body.classes, res.body.lectures], [3, 12]);
    const rows = await db.all("SELECT b.status, b.title, b.course_code, b.lecturer, b.start_time, b.end_time, r.code FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE kind = 'timetable' ORDER BY date, start_time, r.code");
    assert.ok(rows.every((r) => r.status === 'approved'));
    assert.deepEqual(rows[0], { status: 'approved', title: 'International Business', course_code: 'ADM301', lecturer: 'Dr. Mark Bigool', start_time: '09:30', end_time: '11:30', code: 'LT-1' });
    // Shown as booked on the public list.
    const day = (await agent().get(`/api/public/rooms?date=${from}`)).body.rooms.find((r) => r.code === 'LT-1');
    assert.ok(!day.freePeriods.some((p) => p.start <= '09:30' && p.end >= '11:30'));
    const list = (await admin.get('/api/admin/timetables')).body.classes;
    assert.equal(list.length, 3);
    assert.equal(list[0].label, 'B.Com Management L300');
    const removed = await admin.post('/api/admin/timetables/remove').send({ label: 'B.Com Management L300' });
    assert.equal(removed.body.cancelled, 12);
    assert.match((await db.get("SELECT details FROM audit_log WHERE action = 'timetable.import'")).details.label, /L300/);
    const student = await signedIn('kofi@campus.test');
    assert.equal((await student.post('/api/admin/timetables/preview').send({ label: 'x', from, to, table: TABLE })).status, 403);
  });

  test('bad input is refused clearly', async () => {
    const send = (body) => admin.post('/api/admin/timetables/preview').send({ label: 'L300', from, to, table: TABLE, ...body });
    assert.match((await send({ from: 'soon' })).body.error, /first and last teaching days/);
    assert.match((await send({ to: addDays(from, -1) })).body.error, /before the first/);
    assert.match((await send({ label: '' })).body.error, /Name this timetable/);
    assert.match((await send({ to: addDays(from, 7 * 30) })).body.error, /at most 26 weeks/);
  });
});

describe('class check-in for timetable lectures', () => {
  beforeEach(resetDb);
  const minute = toMinutes(localTime());
  const skip = minute < 90 || minute > 22 * 60 ? 'too close to midnight' : false;

  async function lectureNow(startOffset) {
    const admin = await signedIn('boss@campus.test');
    const { id } = await db.get(
      `INSERT INTO bookings (room_id, user_id, title, category, course_code, lecturer, date, start_time, end_time, attendees, status, kind, updated_at)
       VALUES (?, ?, 'International Business', 'lecture', 'ADM301', 'Dr. Mark Bigool', ?, ?, ?, 100, 'approved', 'timetable', now() - interval '1 day') RETURNING id`,
      [await roomId('LT-1'), admin.user.id, localDate(), fromMinutes(minute + startOffset), fromMinutes(minute + startOffset + 60)],
    );
    return { id, admin };
  }
  const code = async () => (await db.get("SELECT door_code FROM rooms WHERE code = 'LT-1'")).door_code;

  test('anyone at the room checks the class in; the door page shows the class', async () => {
    const { id } = await lectureNow(-5);
    const rep = await signedIn('kofi@campus.test');
    const door = (await rep.get(`/api/door/${await code()}`)).body;
    assert.deepEqual([door.class.courseCode, door.class.lecturer, door.class.state], ['ADM301', 'Dr. Mark Bigool', 'open']);
    const res = await rep.post('/api/door/check-in').send({ code: await code(), via: 'qr' });
    assert.equal(res.status, 200);
    assert.equal(res.body.forClass, true);
    const row = await db.get('SELECT checked_in_at, checked_in_by FROM bookings WHERE id = ?', [id]);
    assert.ok(row.checked_in_at);
    assert.equal(row.checked_in_by, rep.user.id);
    assert.equal((await db.get("SELECT details FROM audit_log WHERE action = 'booking.check_in'")).details.class, 'ADM301');
    assert.equal((await rep.get(`/api/door/${await code()}`)).body.class.state, 'checked-in');
  }, { skip });

  test('nobody checks in within 15 minutes: released and shown free; the office gets no notice', async () => {
    const { id, admin } = await lectureNow(-20);
    await agent().get('/api/public/now');
    assert.equal((await db.get('SELECT status FROM bookings WHERE id = ?', [id])).status, 'released');
    assert.equal((await admin.get('/api/notifications')).body.notifications.length, 0);
    const log = await db.get("SELECT details FROM audit_log WHERE action = 'booking.release'");
    assert.equal(log.details.timetable, true);
    const late = await (await signedIn('kofi@campus.test')).post('/api/door/check-in').send({ code: await code() });
    assert.equal(late.status, 409);
    assert.match(late.body.error, /Too late: ADM301 in LT-1 was released/);
  }, { skip });

  test('the office can still make ordinary bookings at the same time as its timetable lectures', async () => {
    const { admin } = await lectureNow(120);
    const res = await admin.post('/api/bookings').send({ roomId: await roomId('NAB-205'), title: 'Meeting', category: 'meeting',
      date: tomorrow(), start: '10:00', end: '11:00', attendees: 5 });
    assert.equal(res.status, 201);
  }, { skip });
});
