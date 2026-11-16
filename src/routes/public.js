'use strict';
const express = require('express');
const rooms = require('../services/rooms');

const router = express.Router();

// Feeds the "Campus Now" landing page before anyone signs in: counts and room codes only.
router.get('/now', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=30, s-maxage=30');
  res.json(await rooms.now());
});

// Every active room with its free periods on ?date= (default today). No booking details.
router.get('/rooms', async (req, res) => {
  // Always fresh: the page reloads it right after a booking, and must show that slot as taken.
  res.set('Cache-Control', 'no-store');
  res.json(await rooms.publicRooms(req.query));
});

module.exports = router;
