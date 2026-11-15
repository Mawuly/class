'use strict';
const express = require('express');
const bookings = require('../services/bookings');
const roomAdmin = require('../services/roomAdmin');
const userAdmin = require('../services/userAdmin');
const access = require('../services/access');
const { requireRole } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { parseId } = require('../utils/validate');

const router = express.Router();
router.use(requireRole('admin'));

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

// ?status=pending (the queue), approved / rejected / cancelled, or "decided" (recent decisions).
router.get('/bookings', async (req, res) => {
  const status = req.query.status || 'pending';
  if (status === 'decided') return res.json({ bookings: await bookings.listDecided() });
  if (!STATUSES.includes(status)) throw new AppError(400, 'Unknown status');
  res.json({ bookings: await bookings.listByStatus(status) });
});

router.get('/bookings/:id/context', async (req, res) => {
  res.json(await bookings.requestContext(parseId(req.params.id, 'Booking')));
});

router.post('/bookings/:id/approve', async (req, res) => {
  const booking = await bookings.decide(req.user, parseId(req.params.id, 'Booking'), 'approved', null, { ip: req.ip });
  res.json({ booking });
});

router.post('/bookings/:id/reject', async (req, res) => {
  const booking = await bookings.decide(req.user, parseId(req.params.id, 'Booking'), 'rejected', req.body?.reason, { ip: req.ip });
  res.json({ booking });
});

/* ---------- Buildings and rooms ---------------------------------------------------- */

router.get('/rooms', async (req, res) => res.json(await roomAdmin.overview()));

router.post('/buildings', async (req, res) => {
  res.status(201).json({ building: await roomAdmin.createBuilding(req.user, req.body ?? {}, { ip: req.ip }) });
});
router.patch('/buildings/:id', async (req, res) => {
  res.json({ building: await roomAdmin.updateBuilding(req.user, parseId(req.params.id, 'Building'), req.body ?? {}, { ip: req.ip }) });
});
router.delete('/buildings/:id', async (req, res) => {
  await roomAdmin.deleteBuilding(req.user, parseId(req.params.id, 'Building'), { ip: req.ip });
  res.json({ ok: true });
});

router.post('/rooms', async (req, res) => {
  res.status(201).json({ room: await roomAdmin.createRoom(req.user, req.body ?? {}, { ip: req.ip }) });
});
router.patch('/rooms/:id', async (req, res) => {
  res.json(await roomAdmin.updateRoom(req.user, parseId(req.params.id, 'Room'), req.body ?? {}, { ip: req.ip }));
});
router.delete('/rooms/:id', async (req, res) => {
  await roomAdmin.deleteRoom(req.user, parseId(req.params.id, 'Room'), { ip: req.ip });
  res.json({ ok: true });
});

/* ---------- People ------------------------------------------------------------------ */

router.get('/users', async (req, res) => res.json(await userAdmin.list(req.query)));
router.post('/users/:id/reset-password', async (req, res) => {
  res.json(await userAdmin.resetPassword(req.user, parseId(req.params.id, 'Person'), { ip: req.ip }));
});
router.patch('/users/:id', async (req, res) => {
  res.json(await userAdmin.update(req.user, parseId(req.params.id, 'Person'), req.body ?? {}, { ip: req.ip }));
});

/* ---------- Staff access requests --------------------------------------------------- */

router.get('/pending-counts', async (req, res) => {
  const [bookingsWaiting, accessWaiting] = await Promise.all([
    bookings.listByStatus('pending').then((b) => b.length),
    access.pendingCount(),
  ]);
  res.json({ bookings: bookingsWaiting, access: accessWaiting });
});

router.get('/access-requests', async (req, res) => {
  res.json({ requests: await access.list(req.query.status === 'decided' ? 'decided' : 'pending') });
});

// The uploaded letter itself. Shown inline in the browser; never cached.
router.get('/access-requests/:id/document', async (req, res) => {
  const doc = await access.document(parseId(req.params.id, 'Request'));
  res.set({
    'Content-Type': doc.document_type,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.document_name)}`,
    'Cache-Control': 'no-store, private',
    // Images may be shown in the review panel on this site; nothing else may frame the file.
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.send(doc.document);
});

router.post('/access-requests/:id/approve', async (req, res) => {
  res.json(await access.decide(req.user, parseId(req.params.id, 'Request'), 'approved', null, { ip: req.ip }));
});
router.post('/access-requests/:id/reject', async (req, res) => {
  res.json(await access.decide(req.user, parseId(req.params.id, 'Request'), 'rejected', req.body?.reason, { ip: req.ip }));
});

// Stats and the audit log come next.

module.exports = router;
