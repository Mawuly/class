'use strict';
const { naturalCode } = require('../utils/sort');
const express = require('express');
const bookings = require('../services/bookings');
const roomAdmin = require('../services/roomAdmin');
const userAdmin = require('../services/userAdmin');
const access = require('../services/access');
const stats = require('../services/stats');
const auditLog = require('../services/audit');
const { requireRole } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { parseId } = require('../utils/validate');
const QRCode = require('qrcode');
const config = require('../config');
const db = require('../db');
const checkin = require('../services/checkin');
const roomBlocks = require('../services/roomBlocks');
const settings = require('../services/settings');
const { baseUrl } = require('./calendar');

const router = express.Router();
router.use(requireRole('admin'));

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'released'];

// ?status=pending (the queue), approved / rejected / cancelled, or "decided" (recent decisions).
router.get('/bookings', async (req, res) => {
  const status = req.query.status || 'pending';
  if (status === 'decided') return res.json({ bookings: await bookings.listDecided() });
  if (!STATUSES.includes(status)) throw new AppError(400, 'Unknown status');
  res.json({ bookings: await bookings.listByStatus(status, { date: req.query.date ? String(req.query.date) : null }) });
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
  res.json({ ok: true, ...(await roomAdmin.deleteRoom(req.user, parseId(req.params.id, 'Room'), { ip: req.ip })) });
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

/* ---------- Statistics ---------------------------------------------------------------- */

router.get('/stats', async (req, res) => res.json(await stats.overview(req.query)));

/* ---------- Audit log ------------------------------------------------------------------ */

router.get('/audit', async (req, res) => {
  const [page, security] = await Promise.all([auditLog.list(req.query), auditLog.securitySummary()]);
  res.json({ ...page, security });
});

// A plain link downloads it: GET needs no CSRF header, and the admin cookie still applies.
router.get('/audit.csv', async (req, res) => {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="audit-log_${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send(await auditLog.csv(req.query));
});

/* ---------- Temporary closures --------------------------------------------------------- */

// Upcoming closures, or ?roomId= / ?date= to narrow it.
router.get('/room-blocks', async (req, res) => res.json({ blocks: await roomBlocks.list(req.query) }));
router.post('/room-blocks', async (req, res) => {
  res.status(201).json({ block: await roomBlocks.create(req.user, req.body ?? {}, { ip: req.ip }) });
});
router.delete('/room-blocks/:id', async (req, res) => {
  res.json({ block: await roomBlocks.remove(req.user, parseId(req.params.id, 'Closure'), { ip: req.ip }) });
});

/* ---------- Booking window (Settings) --------------------------------------------------- */

router.get('/settings', async (req, res) => res.json({ settings: await settings.load() }));
router.patch('/settings', async (req, res) => {
  res.json({ settings: await settings.update(req.user, req.body ?? {}, { ip: req.ip }) });
});

/* ---------- Door signs: QR codes for check-in ----------------------------------------- */

const doorUrl = (req, code) => `${baseUrl(req)}/door?c=${code}`;

// Every active room's sign (or one room's with ?room=ID), for the printable signs page.
router.get('/door-signs', async (req, res) => {
  const one = req.query.room ? parseId(req.query.room, 'Room') : null;
  const rooms = await db.all(
    `SELECT r.id, r.code, r.name, r.capacity, r.door_code, bl.code AS building_code, bl.name AS building_name
     FROM rooms r JOIN buildings bl ON bl.id = r.building_id
     WHERE r.is_active ${one ? 'AND r.id = ?' : ''} ORDER BY bl.code, ${naturalCode('r.code')}`,
    one ? [one] : [],
  );
  if (one && !rooms.length) throw new AppError(404, 'Room not found');
  const { checkInEarlyMinutes, checkInGraceMinutes, releaseNoShows } = config.booking;
  res.json({
    signs: rooms.map((r) => ({ ...r, url: doorUrl(req, r.door_code) })),
    checkIn: { earlyMinutes: checkInEarlyMinutes, graceMinutes: checkInGraceMinutes, release: releaseNoShows },
  });
});

// The QR code itself, as an image the signs page can show and print.
router.get('/rooms/:id/door-qr.svg', async (req, res) => {
  const room = await db.get('SELECT door_code FROM rooms WHERE id = ?', [parseId(req.params.id, 'Room')]);
  if (!room) throw new AppError(404, 'Room not found');
  const svg = await QRCode.toString(doorUrl(req, room.door_code), {
    type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#12161C', light: '#ffffff00' }, // clear background: prints on paper, shows on Bone
  });
  res.type('image/svg+xml').set('Cache-Control', 'private, no-store').send(svg);
});

// A new code when a sign is lost or someone shared a photo of it; the old code stops working.
router.post('/rooms/:id/door-code', async (req, res) => {
  res.json({ room: await checkin.newDoorCode(req.user, parseId(req.params.id, 'Room'), { ip: req.ip }) });
});

module.exports = router;
