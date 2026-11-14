'use strict';
const bcrypt = require('bcryptjs');
const config = require('../config');
const { localDate, addDays } = require('../utils/time');

const BUILDINGS = [
  ['LTB', 'Lecture Theatre Block'],
  ['SCB', 'Science Block'],
  ['NAB', 'New Academic Block'],
  ['LIB', 'Main Library'],
];

// [building, code, name, type, capacity, floor, facilities]
const ROOMS = [
  ['LTB', 'LT-1', 'Lecture Theatre 1', 'lecture_hall', 300, 0, ['projector', 'pa_system', 'ac']],
  ['LTB', 'LT-2', 'Lecture Theatre 2', 'lecture_hall', 200, 0, ['projector', 'pa_system', 'ac']],
  ['LTB', 'LT-3', 'Lecture Theatre 3', 'lecture_hall', 120, 1, ['projector', 'whiteboard']],
  ['SCB', 'SCB-101', 'Computer Lab 1', 'lab', 60, 1, ['computers', 'projector', 'ac']],
  ['SCB', 'SCB-104', 'Seminar Room 104', 'seminar', 40, 1, ['projector', 'whiteboard']],
  ['SCB', 'SCB-105', 'Seminar Room 105', 'seminar', 30, 1, ['whiteboard']],
  ['SCB', 'SCB-201', 'Science Lecture Hall', 'lecture_hall', 150, 2, ['projector', 'pa_system']],
  ['SCB', 'SCB-210', 'Physics Lab', 'lab', 45, 2, ['whiteboard']],
  ['NAB', 'NAB-001', 'Great Hall', 'lecture_hall', 250, 0, ['projector', 'pa_system', 'ac']],
  ['NAB', 'NAB-104', 'Seminar Room 104', 'seminar', 50, 1, ['projector', 'whiteboard', 'ac']],
  ['NAB', 'NAB-205', 'Meeting Room A', 'meeting', 12, 2, ['video_conf', 'whiteboard', 'ac']],
  ['NAB', 'NAB-206', 'Meeting Room B', 'meeting', 16, 2, ['projector', 'ac']],
  ['LIB', 'LIB-S1', 'Study Room 1', 'study', 6, 1, ['whiteboard']],
  ['LIB', 'LIB-S2', 'Study Room 2', 'study', 8, 1, ['whiteboard']],
  ['LIB', 'LIB-S3', 'Library Seminar 3', 'seminar', 20, 2, ['projector', 'whiteboard']],
  ['LIB', 'LIB-G1', 'Group Study Pod', 'study', 10, 0, ['whiteboard', 'ac']],
];

/** Buildings and rooms. Skips anything that already exists. */
async function seedReference(db) {
  for (const [code, name] of BUILDINGS) {
    await db.run('INSERT INTO buildings (code, name) VALUES (?, ?) ON CONFLICT (code) DO NOTHING', [code, name]);
  }
  for (const [b, code, name, type, capacity, floor, facilities] of ROOMS) {
    await db.run(
      `INSERT INTO rooms (building_id, code, name, type, capacity, floor, facilities, bookable_by)
       VALUES ((SELECT id FROM buildings WHERE code = ?), ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING`,
      [b, code, name, type, capacity, floor, JSON.stringify(facilities),
        type === 'lecture_hall' || type === 'lab' ? 'staff' : 'all'],
    );
  }
}

const DEMO_PASSWORD = 'Campus2026';
const DEMO_USERS = [
  ['Timetable Office', 'admin@campus.test', 'admin', 'Registry'],
  ['Dr. Ama Mensah', 'lecturer@campus.test', 'lecturer', 'Computer Science'],
  ['Prof. Yaw Boateng', 'yaw.boateng@campus.test', 'lecturer', 'Mathematics'],
  ['Dr. Efua Owusu', 'efua.owusu@campus.test', 'lecturer', 'Computer Science'],
  ['Kofi Asante', 'student@campus.test', 'student', 'Computer Science'],
];

/**
 * Demo accounts and a spread of bookings for today and tomorrow. Pass a transaction.
 * includeAdmin is only for local development: a deployed site must never have an admin
 * whose password is printed in the README.
 */
async function seedDemo(db, { includeAdmin = true } = {}) {
  const hash = await bcrypt.hash(DEMO_PASSWORD, config.bcryptCost);
  for (const [name, email, role, department] of DEMO_USERS) {
    if (role === 'admin' && !includeAdmin) continue;
    await db.run(
      `INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (lower(email)) DO NOTHING`,
      [name, email, hash, role, department],
    );
  }
  const { n } = await db.get('SELECT count(*)::int AS n FROM bookings');
  if (n > 0) return;

  const id = async (sql, v) => (await db.get(sql, [v])).id;
  const lecturer = await id('SELECT id FROM users WHERE email = ?', 'lecturer@campus.test');
  const yaw = await id('SELECT id FROM users WHERE email = ?', 'yaw.boateng@campus.test');
  const efua = await id('SELECT id FROM users WHERE email = ?', 'efua.owusu@campus.test');
  const student = await id('SELECT id FROM users WHERE email = ?', 'student@campus.test');
  const today = localDate();
  const tomorrow = addDays(today, 1);

  // [room, user, title, category, course, date, start, end, attendees, status]
  const rows = [
    ['LT-1', lecturer, 'Data Structures', 'lecture', 'CSC 201', today, '08:00', '10:00', 260, 'approved'],
    ['LT-1', lecturer, 'Operating Systems', 'lecture', 'CSC 301', today, '13:00', '15:00', 210, 'approved'],
    ['LT-2', yaw, 'Discrete Mathematics', 'lecture', 'MATH 221', today, '10:30', '12:30', 180, 'approved'],
    ['SCB-101', efua, 'Web Development Lab', 'lab', 'CSC 305', today, '09:00', '12:00', 55, 'approved'],
    ['SCB-104', efua, 'Research Methods Tutorial', 'tutorial', 'CSC 401', today, '15:00', '17:00', 30, 'approved'],
    ['NAB-001', yaw, 'Faculty Assembly', 'event', null, today, '16:00', '18:00', 200, 'approved'],
    ['LIB-S3', student, 'Final-year project group', 'meeting', null, today, '14:00', '16:00', 6, 'approved'],
    ['LIB-S1', student, 'Exam revision', 'study', null, tomorrow, '10:00', '12:00', 4, 'pending'],
    ['LT-2', lecturer, 'Software Engineering', 'lecture', 'CSC 303', tomorrow, '08:30', '10:30', 190, 'approved'],
  ];
  for (const [room, user, title, category, course, date, start, end, attendees, status] of rows) {
    await db.run(
      `INSERT INTO bookings (room_id, user_id, title, category, course_code, date, start_time, end_time, attendees, status)
       VALUES ((SELECT id FROM rooms WHERE code = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [room, user, title, category, course, date, start, end, attendees, status],
    );
  }
}

module.exports = { seedReference, seedDemo, DEMO_PASSWORD };

if (require.main === module) {
  const db = require('./index');
  const { migrate } = require('./migrate');
  const withDemo = !process.argv.includes('--no-demo');
  (async () => {
    await migrate(db);
    await seedReference(db);
    if (withDemo) await db.tx((x) => seedDemo(x));
    console.log(withDemo
      ? `Seeded. Demo logins (password ${DEMO_PASSWORD}): admin@ / lecturer@ / student@campus.test`
      : 'Seeded buildings and rooms.');
    await db.pool.end();
  })().catch((err) => { console.error(err); process.exit(1); });
}
