'use strict';
const bcrypt = require('bcryptjs');
const config = require('../config');
const { localDate, addDays } = require('../utils/time');

const { loadCampus } = require('./campus');

/** Buildings and rooms of the configured campus (see db/campus.js). Skips anything that already exists. */
async function seedReference(db, campus = config.campus) {
  await loadCampus(db, campus);
  await db.run(
    `INSERT INTO app_meta (key, value) VALUES ('campus', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [campus],
  );
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
  // The same sample bookings on the real campus's rooms.
  const UCC = {
    'LT-1': 'NLT-1', 'LT-2': 'NLT-2', 'SCB-101': 'LT-5', 'SCB-104': 'G1', 'NAB-001': 'CALC-AUD', 'LIB-S3': 'CRT-1', 'LIB-S1': 'CRT-2',
  };
  for (const [demoRoom, user, title, category, course, date, start, end, attendees, status] of rows) {
    const room = config.campus === 'demo' ? demoRoom : UCC[demoRoom];
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
