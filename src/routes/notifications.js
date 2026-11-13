'use strict';
const express = require('express');
const notifications = require('../services/notifications');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const items = await notifications.list(req.user.id);
  res.json({ notifications: items, unread: items.filter((n) => !n.is_read).length });
});

router.post('/read-all', async (req, res) => {
  await notifications.markAllRead(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
