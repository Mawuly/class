'use strict';
const express = require('express');
const bookings = require('../services/bookings');
const { requireRole } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { parseId } = require('../utils/validate');

const router = express.Router();
router.use(requireRole('admin'));

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

router.get('/bookings', async (req, res) => {
  const status = req.query.status || 'pending';
  if (!STATUSES.includes(status)) throw new AppError(400, 'Unknown status');
  res.json({ bookings: await bookings.listByStatus(status) });
});

router.post('/bookings/:id/approve', async (req, res) => {
  const booking = await bookings.decide(req.user, parseId(req.params.id, 'Booking'), 'approved', null, { ip: req.ip });
  res.json({ booking });
});

router.post('/bookings/:id/reject', async (req, res) => {
  const booking = await bookings.decide(req.user, parseId(req.params.id, 'Booking'), 'rejected', req.body?.reason, { ip: req.ip });
  res.json({ booking });
});

// Room and building management, users, stats and the audit log come in weeks 6–9.

module.exports = router;
