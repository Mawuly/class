'use strict';
const express = require('express');
const bookings = require('../services/bookings');
const { requireAuth } = require('../middleware/auth');
const { parseId } = require('../utils/validate');

const router = express.Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  const booking = await bookings.create(req.user, req.body ?? {}, { ip: req.ip });
  res.status(201).json({ booking });
});

router.get('/mine', async (req, res) => {
  res.json({ bookings: await bookings.listMine(req.user, req.query.scope) });
});

router.post('/:id/cancel', async (req, res) => {
  const booking = await bookings.cancel(req.user, parseId(req.params.id, 'Booking'), { ip: req.ip });
  res.json({ booking });
});

module.exports = router;
