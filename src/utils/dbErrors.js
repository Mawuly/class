'use strict';

/**
 * Turns a database connection or setup error into a plain-English fix, or null when the
 * error is not one of these. Never includes the connection string.
 */
function databaseHint(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'The database host name was not found. Copy the connection string again from Supabase → Connect.';
  }
  if (['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET'].includes(code)
      || /connection timeout|timeout exceeded when trying to connect/i.test(msg)) {
    return "Could not reach the database. Supabase's direct connection (db.<ref>.supabase.co) only works over IPv6, "
      + 'which Vercel does not support: use the Transaction pooler string (…pooler.supabase.com:6543) instead.';
  }
  if (code === '28P01' || /password authentication failed/i.test(msg)) {
    return 'Wrong database password. Reset it in Supabase → Project Settings → Database and update the connection string. '
      + 'Symbols in the password must be URL-encoded (@ → %40, # → %23, / → %2F).';
  }
  if (/tenant or user not found/i.test(msg)) {
    return 'Supabase did not recognise the user. With the pooler, the user name must be postgres.<project-ref>, '
      + 'exactly as shown in Supabase → Connect.';
  }
  if (/certificate/i.test(msg) || code.startsWith('SELF_SIGNED') || code.startsWith('UNABLE_TO')) {
    return 'TLS certificate check failed. Remove DATABASE_CA, or set it to the CA certificate from Supabase → Database settings.';
  }
  if (code === '42501') {
    return 'The database user is not allowed to create tables. Use the postgres user from Supabase → Connect.';
  }
  return null;
}

module.exports = { databaseHint };
