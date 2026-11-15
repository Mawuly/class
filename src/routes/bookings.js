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

// Weekly bookings (lecturers and admins). Preview first, then book.
router.post('/series/preview', async (req, res) => {
  res.json(await bookings.previewSeries(req.user, req.body ?? {}));
});
router.post('/series', async (req, res) => {
  res.status(201).json(await bookings.createSeries(req.user, req.body ?? {}, { ip: req.ip }));
});
router.post('/series/:id/cancel', async (req, res) => {
  res.json(await bookings.cancelSeries(req.user, parseId(req.params.id, 'Weekly booking'), { ip: req.ip }));
});

router.get('/mine', async (req, res) => {
  res.json({ bookings: await bookings.listMine(req.user, req.query.scope) });
});

router.post('/:id/cancel', async (req, res) => {
  const booking = await bookings.cancel(req.user, parseId(req.params.id, 'Booking'), { ip: req.ip });
  res.json({ booking });
});

module.exports = router;
