'use strict';
const crypto = require('crypto');

// Ghana is UTC+0 all year; pin it so "today" and "now" never depend on the host.
process.env.TZ = process.env.TZ || 'Africa/Accra';

const env = process.env.NODE_ENV || 'development';
// Vercel sets VERCEL_ENV on every deployment, including previews, whatever NODE_ENV says.
const isProd = env === 'production' || Boolean(process.env.VERCEL_ENV);
const isTest = env === 'test';

// Missing settings must not crash the server: a crash on Vercel shows a bare
// "FUNCTION_INVOCATION_FAILED" page. Instead the API refuses requests with a clear
// message (see app.js) and /api/health lists what is missing.
const problems = [];
if (isProd && !process.env.JWT_SECRET) problems.push('JWT_SECRET is not set');
if (isProd && !process.env.DATABASE_URL) problems.push('DATABASE_URL is not set');
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) problems.push('JWT_SECRET is shorter than 32 characters');
for (const p of problems) console.error(`[config] ${p}. Add it in Vercel → Project → Settings → Environment Variables, then redeploy.`);

const LOCAL = 'postgres://postgres:postgres@localhost:5432';

module.exports = {
  env,
  isProd,
  isTest,
  problems,
  port: Number(process.env.PORT) || 3000,
  // Supabase Postgres in production; a local Postgres in development and tests.
  databaseUrl: isTest
    ? process.env.DATABASE_URL_TEST || `${LOCAL}/rooms_test`
    : process.env.DATABASE_URL || `${LOCAL}/rooms_dev`,
  // Optional: Supabase's CA certificate (Project Settings → Database → SSL) so TLS is verified.
  databaseCa: process.env.DATABASE_CA || '',
  // In production without a secret, use a random one so a guessable default is never used.
  jwtSecret: process.env.JWT_SECRET
    || (isProd ? crypto.randomBytes(48).toString('hex') : 'dev-only-secret-do-not-use-in-production'),
  jwtTtlSeconds: 8 * 60 * 60,
  // e.g. "ug.edu.gh" — leave empty to allow any email address
  allowedEmailDomain: (process.env.ALLOWED_EMAIL_DOMAIN || '').toLowerCase(),
  bcryptCost: isTest ? 4 : 12,
  authRateLimit: { windowMs: 15 * 60 * 1000, max: isTest ? 10000 : 10 },
  booking: {
    open: '07:00',
    close: '21:00',
    slotMinutes: 30,
    maxHours: 6,
    maxDaysAhead: 150,
  },
};
