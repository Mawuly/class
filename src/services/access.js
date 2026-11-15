'use strict';
// Staff verification: people ask for lecturer or admin access by uploading an offer or
// appointment letter. An admin checks the letter and decides. The letter is deleted once
// decided; only its SHA-256 fingerprint stays, as a record of which file was checked.
const crypto = require('crypto');
const db = require('../db');
const { AppError } = require('../utils/errors');
const { audit } = require('./audit');
const { notify } = require('./notifications');

const MAX_BYTES = 3 * 1024 * 1024; // fits under Vercel's 4.5 MB request limit once base64-encoded
const ROLE_NAME = { lecturer: 'lecturer', admin: 'admin (timetable office)' };

/** Checks the file's first bytes, so a renamed .exe can't pass as a PDF. */
function sniff(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

const s = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

function cleanFileName(name, type) {
  const ext = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }[type];
  const base = s(name, 120).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\w .()-]+/g, '_').trim() || 'letter';
  return `${base}${ext}`;
}

const PUBLIC_COLUMNS = `a.id, a.user_id, a.role, a.staff_id, a.position, a.department, a.note, a.document_name,
  a.document_type, a.document_size, a.document_sha256, a.status, a.decision_reason, a.created_at, a.decided_at,
  (a.document IS NOT NULL) AS has_document`;

/** A signed-in person asks for lecturer or admin access. */
async function create(user, input, { ip } = {}) {
  const role = s(input.role, 20);
  if (!ROLE_NAME[role]) throw new AppError(400, 'Choose lecturer or admin access');
  if (user.role === role || (user.role === 'admin')) throw new AppError(400, `You already have ${user.role} access`);
  const staffId = s(input.staffId, 30);
  const position = s(input.position, 80);
  const department = s(input.department, 80) || null;
  const note = s(input.note, 500) || null;
  if (staffId.length < 2) throw new AppError(400, 'Enter your staff ID number');
  if (position.length < 2) throw new AppError(400, 'Enter your position, e.g. Lecturer or Timetable Officer');

  const doc = input.document || {};
  if (typeof doc.data !== 'string' || !doc.data) throw new AppError(400, 'Attach your offer or appointment letter');
  if (doc.data.length > Math.ceil((MAX_BYTES * 4) / 3) + 4) throw new AppError(413, 'The letter must be 3 MB or smaller');
  const buf = Buffer.from(doc.data, 'base64');
  if (!buf.length) throw new AppError(400, 'The letter could not be read. Please attach it again.');
  if (buf.length > MAX_BYTES) throw new AppError(413, 'The letter must be 3 MB or smaller');
  const type = sniff(buf);
  if (!type) throw new AppError(400, 'The letter must be a PDF, JPG or PNG file');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  try {
    return await db.tx(async (x) => {
      const row = await x.get(
        `INSERT INTO access_requests (user_id, role, staff_id, position, department, note, document,
           document_name, document_type, document_size, document_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [user.id, role, staffId, position, department, note, buf, cleanFileName(doc.name, type), type, buf.length, sha256],
      );
      if (department) await x.run('UPDATE users SET department = coalesce(department, ?) WHERE id = ?', [department, user.id]);
      const admins = await x.all("SELECT id FROM users WHERE role = 'admin' AND is_active");
      for (const a of admins) {
        await notify(a.id, `${user.name} asked for ${ROLE_NAME[role]} access and attached a letter to check. See Approvals → Staff access.`, x);
      }
      await audit({ userId: user.id, action: 'access.request', entity: 'access_request', entityId: row.id,
        details: { role, sha256 }, ip }, x);
      return mine(user, x);
    });
  } catch (err) {
    if (err.code === '23505') throw new AppError(409, 'You already have a request waiting. The timetable office will decide soon.');
    throw err;
  }
}

/** The person's latest request, for their dashboard. */
async function mine(user, exec = db) {
  const row = await exec.get(
    `SELECT ${PUBLIC_COLUMNS} FROM access_requests a WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 1`,
    [user.id],
  );
  return row || null;
}

/** Admin list: 'pending' (oldest first) or 'decided' (newest first). Never includes the file itself. */
async function list(status = 'pending') {
  const pending = status === 'pending';
  return db.all(
    `SELECT ${PUBLIC_COLUMNS}, u.name AS user_name, u.email AS user_email, u.role AS user_role,
            u.created_at AS user_created_at, d.name AS decided_by_name
     FROM access_requests a JOIN users u ON u.id = a.user_id LEFT JOIN users d ON d.id = a.decided_by
     WHERE ${pending ? "a.status = 'pending'" : "a.status <> 'pending'"}
     ORDER BY ${pending ? 'a.created_at ASC' : 'a.decided_at DESC'} LIMIT 200`,
  );
}

async function pendingCount() {
  const { n } = await db.get("SELECT count(*)::int AS n FROM access_requests WHERE status = 'pending'");
  return n;
}

/** The uploaded letter, for an admin to look at. Gone once the request has been decided. */
async function document(id) {
  const row = await db.get('SELECT document, document_name, document_type FROM access_requests WHERE id = ?', [id]);
  if (!row) throw new AppError(404, 'Request not found');
  if (!row.document) throw new AppError(410, 'This letter was deleted after the request was decided');
  return row;
}

/** Approve or reject. Approving changes the person's role. Either way the letter is deleted. */
async function decide(admin, id, decision, reason, { ip } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new AppError(400, 'Invalid decision');
  const cleanReason = s(reason, 300) || null;
  return db.tx(async (x) => {
    const req = await x.get(
      `SELECT a.id, a.user_id, a.role, a.status, a.document_sha256, u.name, u.is_active, u.role AS current_role
       FROM access_requests a JOIN users u ON u.id = a.user_id WHERE a.id = ? FOR UPDATE OF a`,
      [id],
    );
    if (!req) throw new AppError(404, 'Request not found');
    if (req.status !== 'pending') throw new AppError(409, `This request was already ${req.status}`);
    if (req.user_id === admin.id) throw new AppError(403, 'You can’t decide your own request');
    if (decision === 'approved' && !req.is_active) throw new AppError(409, `${req.name}'s account is deactivated. Reactivate it first.`);

    await x.run(
      `UPDATE access_requests SET status = ?, decided_by = ?, decision_reason = ?, decided_at = now(), document = NULL
       WHERE id = ?`,
      [decision, admin.id, cleanReason, id],
    );
    if (decision === 'approved' && req.current_role !== 'admin') {
      await x.run('UPDATE users SET role = ? WHERE id = ?', [req.role, req.user_id]);
    }
    await notify(req.user_id, decision === 'approved'
      ? `Your request for ${ROLE_NAME[req.role]} access was approved. You have it from now on.`
      : `Your request for ${ROLE_NAME[req.role]} access was not approved.`
        + `${cleanReason ? ` Reason: ${cleanReason}${/[.!?]$/.test(cleanReason) ? '' : '.'}` : ''} `
        + 'You can send a new request from your dashboard.', x);
    await audit({
      userId: admin.id, action: `access.${decision === 'approved' ? 'approve' : 'reject'}`, entity: 'access_request', entityId: id,
      details: { role: req.role, for_user: req.user_id, letter_sha256: req.document_sha256, ...(cleanReason ? { reason: cleanReason } : {}) },
      ip,
    }, x);
    return { id, status: decision };
  });
}

module.exports = { MAX_BYTES, sniff, create, mine, list, pendingCount, document, decide };
