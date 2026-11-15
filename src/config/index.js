'use strict';
const crypto = require('crypto');

// Ghana is UTC+0 all year; pin it so "today" and "now" never depend on the host.
process.env.TZ = process.env.TZ || 'Africa/Accra';

const env = process.env.NODE_ENV || 'development';
// Vercel sets VERCEL_ENV on every deployment, including previews, whatever NODE_ENV says.
const isProd = env === 'production' || Boolean(process.env.VERCEL_ENV);
const isTest = env === 'test';

const LOCAL = 'postgres://postgres:postgres@localhost:5432';

/**
 * Removes connection-string options that node-postgres would misread. Supabase's
 * "sslmode=require" makes pg demand a certificate chain Supabase's pooler does not
 * provide, so the connection fails; TLS is configured in db/index.js instead.
 */
function cleanDatabaseUrl(raw) {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    for (const key of ['sslmode', 'sslrootcert', 'supa', 'pgbouncer', 'connection_limit']) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return raw;
  }
}

// DATABASE_URL if you set it yourself; POSTGRES_URL / POSTGRES_PRISMA_URL are what Vercel's
// Supabase integration (Vercel → Storage → Supabase) adds automatically.
const productionDbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || '';

const databaseUrl = cleanDatabaseUrl(isTest
  ? process.env.DATABASE_URL_TEST || `${LOCAL}/rooms_test`
  : productionDbUrl || `${LOCAL}/rooms_dev`);

/**
 * JWT_SECRET is optional. Without it, the signing key is derived from the database URL,
 * which already contains the database password: secret, and the same on every Vercel
 * instance. Changing the database password then signs everyone out, which is harmless.
 */
function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!isProd) return 'dev-only-secret-do-not-use-in-production';
  if (productionDbUrl) return crypto.createHmac('sha256', productionDbUrl).update('lecture-rooms/jwt').digest('hex');
  return crypto.randomBytes(48).toString('hex'); // unusable anyway: the API refuses requests without a database
}

// Missing settings must not crash the server: a crash on Vercel shows a bare
// "FUNCTION_INVOCATION_FAILED" page. Instead the API refuses requests with a clear
// message (see app.js) and /api/health lists what is missing.
const problems = [];
if (isProd && !productionDbUrl) {
  problems.push('No database is connected. In Vercel open Storage and connect your Supabase project, '
    + 'or add DATABASE_URL (Supabase → Connect → Transaction pooler) under Settings → Environment Variables');
}
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) problems.push('JWT_SECRET is shorter than 32 characters');
for (const p of problems) console.error(`[config] ${p}. Then redeploy.`);

const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

module.exports = {
  env,
  isProd,
  isTest,
  problems,
  port: Number(process.env.PORT) || 3000,
  databaseUrl,
  hasDatabaseUrl: Boolean(productionDbUrl) || !isProd,
  cleanDatabaseUrl,
  // Optional: Supabase's CA certificate (Project Settings → Database → SSL) so TLS is verified.
  databaseCa: process.env.DATABASE_CA || '',
  jwtSecret: jwtSecret(),
  jwtTtlSeconds: 8 * 60 * 60,
  // Whoever registers or signs in with one of these emails becomes an admin. Comma-separated.
  adminEmails: list(process.env.ADMIN_EMAILS),
  // SEED_DEMO=true adds demo lecturers, a demo student and sample bookings (never a demo admin).
  seedDemo: /^(1|true|yes)$/i.test(process.env.SEED_DEMO || ''),
  // Email for password reset codes (SMTP). With these unset, "Forgot password" falls back to
  // telling the timetable office. In development and tests, codes are not sent (see services/mail.js).
  mail: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  },
  // Text messages through Arkesel (arkesel.com), for password reset codes. The sender ID must be
  // registered and approved in your Arkesel account (at most 11 characters).
  sms: {
    apiKey: process.env.ARKESEL_API_KEY || '',
    sender: process.env.ARKESEL_SENDER_ID || '',
    url: process.env.ARKESEL_URL || 'https://sms.arkesel.com/api/v2/sms/send',
    // "true" asks Arkesel to accept messages without sending or charging: for testing the set-up.
    sandbox: /^(1|true|yes)$/i.test(process.env.ARKESEL_SANDBOX || ''),
  },
  // Which campus's buildings and rooms to load: "ucc" (University of Cape Coast) or "demo"
  // (a small made-up campus, used by the tests). See db/campus.js.
  campus: (process.env.CAMPUS || (isTest ? 'demo' : 'ucc')).toLowerCase(),
  // "Continue with Google" (Google Cloud → APIs & Services → Credentials → OAuth client ID, type
  // "Web application"). Both are needed; without them the Google button is hidden.
  // GOOGLE_REDIRECT_URI only for a custom setup; normally it is <site>/api/auth/google/callback.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  },
  // e.g. "ug.edu.gh" — leave empty to allow any email address
  allowedEmailDomain: (process.env.ALLOWED_EMAIL_DOMAIN || '').toLowerCase(),
  bcryptCost: isTest ? 4 : 12,
  authRateLimit: { windowMs: 15 * 60 * 1000, max: isTest ? 10000 : 10 },
  // Defaults for the booking window; the live values come from /admin → Settings (app_meta).
  booking: {
    open: '06:30',
    close: '20:30',
    slotMinutes: 30,   // start times every 30 minutes
    maxHours: 4,       // bookings last whole hours, up to this many
    maxDaysAhead: 150,
    // Check-in at the door: from this many minutes before the start...
    checkInEarlyMinutes: 10,
    // ...until this many minutes after it. Then an approved booking nobody checked in to is
    // released and the room becomes free. CHECKIN_RELEASE=off keeps check-in but never releases.
    checkInGraceMinutes: Math.min(60, Math.max(5, Number(process.env.CHECKIN_GRACE_MINUTES) || 15)),
    releaseNoShows: !/^(0|off|false|no)$/i.test(process.env.CHECKIN_RELEASE || ''),
  },
};
