'use strict';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAILS = 'Boss@Campus.test, head@campus.test';

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { seedReference } = require('../src/db/seed');
const { localDate, addDays } = require('../src/utils/time');

const PASSWORD = 'Testing123';

/** Empties the test database and loads the standard buildings and rooms. */
async function resetDb() {
  await migrate(db);
  await db.pool.query(`TRUNCATE audit_log, notifications, bookings, booking_series, rooms, buildings, users
                       RESTART IDENTITY CASCADE`);
  await seedReference(db);
}

/** A supertest agent that keeps cookies and always sends the CSRF header. */
function agent() {
  const a = request.agent(app);
  const wrap = (method) => (url) => a[method](url).set('X-Requested-With', 'XMLHttpRequest');
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete'), raw: a };
}

/** Registers a user, optionally promotes them, and returns a signed-in agent. */
async function signedIn(email, role = 'student') {
  const a = agent();
  const res = await a.post('/api/auth/register').send({ name: email.split('@')[0], email, password: PASSWORD });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (role !== 'student') await db.run('UPDATE users SET role = ? WHERE lower(email) = ?', [role, email]);
  a.user = res.body.user;
  return a;
}

const roomId = async (code) => (await db.get('SELECT id FROM rooms WHERE code = ?', [code])).id;
const tomorrow = () => addDays(localDate(), 1);

module.exports = { app, db, request, agent, signedIn, resetDb, roomId, tomorrow, PASSWORD };
