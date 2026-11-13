'use strict';
const db = require('../db');

async function notify(userId, message, exec = db) {
  await exec.run('INSERT INTO notifications (user_id, message) VALUES (?, ?)', [userId, message]);
}

async function list(userId) {
  return db.all(
    'SELECT id, message, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50',
    [userId],
  );
}

async function markAllRead(userId) {
  await db.run('UPDATE notifications SET is_read = true WHERE user_id = ? AND NOT is_read', [userId]);
}

module.exports = { notify, list, markAllRead };
