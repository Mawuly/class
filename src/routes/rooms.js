'use strict';
const express = require('express');
const rooms = require('../services/rooms');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Fixed paths come before "/:id" so they are not read as a room id.
router.get('/meta', async (req, res) => res.json(await rooms.meta()));
router.get('/available', async (req, res) => res.json({ rooms: await rooms.available(req.user, req.query) }));
router.get('/schedule/day', async (req, res) => res.json(await rooms.daySchedule(req.user, req.query)));
router.get('/', async (req, res) => res.json({ rooms: await rooms.list(req.query) }));
router.get('/:id/week', async (req, res) => res.json(await rooms.week(req.user, req.params.id, req.query)));
router.get('/:id', async (req, res) => {
  const room = await rooms.get(req.params.id);
  res.json({ room: { ...room, canBook: rooms.canBook(req.user, room) } });
});

module.exports = router;
