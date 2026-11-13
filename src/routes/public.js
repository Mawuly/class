'use strict';
const express = require('express');
const rooms = require('../services/rooms');

const router = express.Router();

// Feeds the "Campus Now" landing page before anyone signs in: counts and room codes only.
router.get('/now', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=30, s-maxage=30');
  res.json(await rooms.now());
});

module.exports = router;
