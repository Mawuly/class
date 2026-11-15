'use strict';
const express = require('express');
const calendar = require('../services/calendar');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

function sendIcs(res, body, filename, { download = true, cache = 'no-store' } = {}) {
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
    'Cache-Control': cache,
  });
  res.send(body);
}

// The subscription feed. Calendar apps fetch it with no login, so the secret token in the
// address is what protects it. Unknown or revoked tokens get a plain 404.
router.get('/feed/:file', async (req, res) => {
  const token = String(req.params.file).replace(/\.ics$/, '');
  sendIcs(res, await calendar.feed(token, baseUrl(req)), 'lecture-rooms.ics', { download: false, cache: 'private, max-age=300' });
});

router.get('/status', requireAuth, async (req, res) => res.json(await calendar.feedStatus(req.user)));
router.post('/feed', requireAuth, async (req, res) => res.status(201).json(await calendar.createFeed(req.user, baseUrl(req), { ip: req.ip })));
router.delete('/feed', requireAuth, async (req, res) => {
  await calendar.removeFeed(req.user, { ip: req.ip });
  res.json({ ok: true });
});

module.exports = { router, sendIcs, baseUrl };
