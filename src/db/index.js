'use strict';
const { Pool, types } = require('pg');
const config = require('../config');

// Return dates as 'YYYY-MM-DD' and times as 'HH:MM' strings, exactly as the API uses them,
// instead of JavaScript Date objects that would shift with time zones.
types.setTypeParser(types.builtins.DATE, (v) => v);
types.setTypeParser(types.builtins.TIME, (v) => v.slice(0, 5));

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl);

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Supabase requires TLS. With DATABASE_CA set, the server certificate is also verified.
  ssl: isLocal ? false : config.databaseCa ? { ca: config.databaseCa } : { rejectUnauthorized: false },
  // Each Vercel function instance keeps a tiny pool; Supabase's pooler does the real pooling.
  max: config.isProd ? 3 : 10,
  idleTimeoutMillis: 10_000,
});

/** Lets queries use "?" placeholders, numbered here as Postgres's $1, $2, ... */
function numbered(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function helpers(q) {
  return {
    async all(sql, args = []) { return (await q.query(numbered(sql), args)).rows; },
    async get(sql, args = []) { return (await q.query(numbered(sql), args)).rows[0]; },
    async run(sql, args = []) {
      const r = await q.query(numbered(sql), args);
      return { changes: r.rowCount, rows: r.rows };
    },
  };
}

/** Runs fn inside a transaction on a single connection; rolls back if fn throws. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(helpers(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, tx, ...helpers(pool) };
