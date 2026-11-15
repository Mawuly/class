'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const checkin = require('../services/checkin');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Typing codes at random can't find a room's code: 20 tries per person per 15 minutes.
const checkInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.isTest ? 10000 : 20,
  keyGenerator: (req) => `user:${req.user.id}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many check-in attempts. Please wait a few minutes and try again.' },
});

// Check in to your booking with the code on the door (typed, or from the QR code).
router.post('/check-in', requireAuth, checkInLimiter, async (req, res) => {
  const via = req.body?.via === 'qr' ? 'qr' : 'code';
  res.json(await checkin.checkIn(req.user, req.body?.code, { via, ip: req.ip }));
});

// The page the QR code on a door opens. Works without signing in (times only).
router.get('/:code', async (req, res) => {
  res.json(await checkin.door(req.params.code, req.user));
});

module.exports = router;
