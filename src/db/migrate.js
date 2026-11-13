'use strict';
const fs = require('fs');
const path = require('path');

async function migrate(db) {
  await db.pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

module.exports = { migrate };

if (require.main === module) {
  const db = require('./index');
  migrate(db)
    .then(() => { console.log('Schema is up to date.'); return db.pool.end(); })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
