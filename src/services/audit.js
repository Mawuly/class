'use strict';
const db = require('../db');

async function audit({ userId = null, action, entity = null, entityId = null, details = null, ip = null }, exec = db) {
  await exec.run(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, action, entity, entityId, details == null ? null : JSON.stringify(details), ip],
  );
}

module.exports = { audit };
