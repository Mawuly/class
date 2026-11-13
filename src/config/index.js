'use strict';
// Ghana is UTC+0 all year; pin it so "today" and "now" never depend on the host.
process.env.TZ = process.env.TZ || 'Africa/Accra';

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';
const isTest = env === 'test';

if (isProd && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}
if (isProd && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set in production (the Supabase connection string)');
}

const LOCAL = 'postgres://postgres:postgres@localhost:5432';

module.exports = {
  env,
  isProd,
  isTest,
  port: Number(process.env.PORT) || 3000,
  // Supabase Postgres in production; a local Postgres in development and tests.
  databaseUrl: isTest
    ? process.env.DATABASE_URL_TEST || `${LOCAL}/rooms_test`
    : process.env.DATABASE_URL || `${LOCAL}/rooms_dev`,
  // Optional: Supabase's CA certificate (Project Settings → Database → SSL) so TLS is verified.
  databaseCa: process.env.DATABASE_CA || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-do-not-use-in-production',
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
