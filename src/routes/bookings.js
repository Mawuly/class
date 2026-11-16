'use strict';
const express = require('express');
const bookings = require('../services/bookings');
const { requireAuth } = require('../middleware/auth');
const { parseId } = require('../utils/validate');
const calendar = require('../services/calendar');
const { sendIcs, baseUrl } = require('./calendar');
const { checkInState } = require('../services/checkin');

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

// Calendar files: all your upcoming bookings, or one booking.
router.get('/mine.ics', async (req, res) => {
  sendIcs(res, await calendar.download(req.user, baseUrl(req)), 'my-room-bookings.ics');
});
router.get('/:id/calendar.ics', async (req, res) => {
  const one = await calendar.single(req.user, parseId(req.params.id, 'Booking'), baseUrl(req));
  sendIcs(res, one.body, `${one.room}_${one.date}.ics`);
});

// Each booking carries its check-in state, which the main site's "My bookings" page reads:
// check_in_state (early, open, checked-in, checked-out, released, not-approved, ended),
// check_in_opens_at and check_in_by.
router.get('/mine', async (req, res) => {
  const now = new Date();
  const list = await bookings.listMine(req.user, req.query.scope);
  res.json({
    bookings: list.map((b) => {
      const s = checkInState(b, now);
      return {
        ...b,
        check_in_state: b.checked_out_at ? 'checked-out' : s.state,
        check_in_opens_at: s.opensAt,
        check_in_by: s.deadline,
      };
    }),
  });
});

// Leaving early: ends the booking now and frees the rest of the slot.
router.post('/:id/check-out', async (req, res) => {
  res.json({ booking: await bookings.checkOut(req.user, parseId(req.params.id, 'Booking'), { ip: req.ip }) });
});

router.post('/:id/cancel', async (req, res) => {
  const booking = await bookings.cancel(req.user, parseId(req.params.id, 'Booking'), { ip: req.ip });
  res.json({ booking });
});

router.post('/:id/check-out', async (req, res) => {
  const booking = await bookings.checkOut(req.user, parseId(req.params.id, 'Booking'), { ip: req.ip });
  res.json({ booking });
});

module.exports = router;
