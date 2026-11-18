'use strict';
// Managing people (admins only): roles, details, deactivating accounts, resetting passwords.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');
const { audit } = require('./audit');
const { notify } = require('./notifications');

const ROLES = ['student', 'lecturer', 'admin'];
const ROLE_NAME = { student: 'student', lecturer: 'lecturer', admin: 'admin' };
const HOLDING = "('pending', 'approved')";

const s = (v) => (v == null ? '' : String(v).trim());

/**
 * Everyone, with how much they use the system. Filters: q (name, email or index number),
 * role, status ('active' | 'inactive' | 'all').
 */
async function list({ q = '', role = '', status = 'active' } = {}) {
  const today = t.localDate();
  const now = t.localTime();
  const where = [];
  const args = [today, today, now];
  if (ROLES.includes(role)) { where.push('u.role = ?'); args.push(role); }
  if (status === 'active') where.push('u.is_active');
  if (status === 'inactive') where.push('NOT u.is_active');
  const term = s(q).toLowerCase().slice(0, 80);
  if (term) {
    where.push("(lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR lower(coalesce(u.index_number, '')) LIKE ?)");
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like, like);
  }
  const rows = await db.all(
    `SELECT u.id, u.name, u.email, u.role, u.department, u.index_number, u.is_active, u.created_at,
            (SELECT max(a.created_at) FROM audit_log a WHERE a.user_id = u.id AND a.action = 'auth.login') AS last_login,
            -- A "forgot password" note that hasn't been dealt with by a reset or change since.
            (SELECT max(a.created_at) FROM audit_log a WHERE a.user_id = u.id AND a.action = 'auth.reset_requested'
               HAVING max(a.created_at) > coalesce(u.password_changed_at, '-infinity'::timestamptz)) AS reset_requested_at,
            u.must_change_password,
            count(b.id)::int AS total_bookings,
            count(b.id) FILTER (WHERE b.status IN ${HOLDING}
              AND (b.date > ? OR (b.date = ? AND b.end_time > ?)))::int AS upcoming
     FROM users u LEFT JOIN bookings b ON b.user_id = u.id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     GROUP BY u.id ORDER BY u.is_active DESC, lower(u.name) LIMIT 500`,
    args,
  );
  const counts = await db.get(
    `SELECT count(*) FILTER (WHERE is_active)::int AS active,
            count(*) FILTER (WHERE NOT is_active)::int AS inactive,
            count(*) FILTER (WHERE is_active AND role = 'student')::int AS students,
            count(*) FILTER (WHERE is_active AND role = 'lecturer')::int AS lecturers,
            count(*) FILTER (WHERE is_active AND role = 'admin')::int AS admins
     FROM users`,
  );
  return {
    users: rows.map((u) => ({ ...u, in_admin_emails: config.adminEmails.includes(u.email.toLowerCase()) })),
    counts,
  };
}

/**
 * Updates someone's role, details or whether their account is active.
 * Guards: no changing your own role or deactivating yourself; never leave the system without
 * an active admin; people in ADMIN_EMAILS can't be demoted here (they'd be re-promoted at sign-in).
 * Deactivating someone with upcoming bookings needs cancelUpcoming: true.
 */
async function update(admin, id, input, { ip } = {}) {
  const changes = {};
  if (input.role !== undefined) {
    if (!ROLES.includes(input.role)) throw new AppError(400, 'Choose student, lecturer or admin');
    changes.role = input.role;
  }
  if (input.name !== undefined) {
    changes.name = s(input.name);
    if (changes.name.length < 2 || changes.name.length > 80) throw new AppError(400, 'Name: 2–80 characters');
  }
  if (input.department !== undefined) changes.department = s(input.department).slice(0, 80) || null;
  if (input.indexNumber !== undefined) changes.index_number = s(input.indexNumber).slice(0, 30) || null;
  const deactivate = input.isActive === false;
  const reactivate = input.isActive === true;

  return db.tx(async (x) => {
    const user = await x.get('SELECT id, name, email, role, is_active FROM users WHERE id = ? FOR UPDATE', [id]);
    if (!user) throw new AppError(404, 'Person not found');
    const self = user.id === admin.id;
    const roleChanging = changes.role && changes.role !== user.role;

    if (self && roleChanging) throw new AppError(403, 'You can’t change your own role. Ask another admin.');
    if (self && deactivate) throw new AppError(403, 'You can’t deactivate your own account.');
    if (roleChanging && user.role === 'admin' && config.adminEmails.includes(user.email.toLowerCase())) {
      throw new AppError(409, `${user.email} is listed in ADMIN_EMAILS, so they would be made admin again at their next sign-in. `
        + 'Remove them from ADMIN_EMAILS in Vercel first.');
    }
    if (user.role === 'admin' && user.is_active && (deactivate || (roleChanging && changes.role !== 'admin'))) {
      // Serialise admin removals so two admins can't demote each other at the same moment.
      await x.run('SELECT pg_advisory_xact_lock(72710002)');
      const { n } = await x.get("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active AND id <> ?", [id]);
      if (n === 0) throw new AppError(409, 'This is the only active admin. Make someone else an admin first.');
    }

    let cancelled = 0;
    if (deactivate && user.is_active) {
      const today = t.localDate();
      const upcoming = await x.all(
        `SELECT id FROM bookings WHERE user_id = ? AND status IN ${HOLDING}
           AND (date > ? OR (date = ? AND end_time > ?)) FOR UPDATE`,
        [id, today, today, t.localTime()],
      );
      if (upcoming.length && input.cancelUpcoming !== true) {
        const one = upcoming.length === 1;
        throw new AppError(409, `${user.name} has ${upcoming.length} upcoming booking${one ? '' : 's'}. `
          + `Deactivating the account cancels ${one ? 'it' : 'them'} and frees the room${one ? '' : 's'}.`,
        { upcoming: upcoming.length, needsConfirm: true });
      }
      if (upcoming.length) {
        await x.run(
          `UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = ANY(?::int[])`,
          [upcoming.map((b) => b.id)],
        );
      }
      cancelled = upcoming.length;
    }

    const sets = Object.keys(changes).map((k) => `${k} = ?`);
    const args = Object.values(changes);
    if (deactivate) sets.push('is_active = false');
    if (reactivate) sets.push('is_active = true');
    if (!sets.length) throw new AppError(400, 'Nothing to change');
    await x.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);

    if (roleChanging) {
      const what = { student: 'a student account: you can request study, seminar and meeting rooms',
        lecturer: 'a lecturer account: your bookings are confirmed straight away and you can book lecture halls and labs',
        admin: 'an admin account: you can approve requests and manage rooms and people' }[changes.role];
      await notify(id, `Your account is now ${what}.`, x);
    }
    const action = deactivate ? 'user.deactivate' : reactivate ? 'user.reactivate'
      : roleChanging ? 'user.role_change' : 'user.update';
    await audit({
      userId: admin.id, action, entity: 'user', entityId: id, ip,
      details: { ...changes, ...(roleChanging ? { from: ROLE_NAME[user.role] } : {}), ...(cancelled ? { cancelled } : {}) },
    }, x);
    return { id, cancelled };
  });
}

// No 0/O, 1/I/L: the password is read aloud or written down, so nothing should be mistaken.
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TEMP_HOURS = 72;

function temporaryPassword() {
  const pick = () => TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `${group()}-${group()}-${group()}`; // about 59 bits of randomness
}

/**
 * Gives someone a one-time temporary password, valid for 72 hours, and signs them out
 * everywhere. They must choose their own password when they next sign in. The temporary
 * password is returned once, to show the admin; only its hash is stored.
 */
async function resetPassword(admin, id, { ip } = {}) {
  if (id === admin.id) throw new AppError(403, 'Use Change password (under your name) for your own account.');
  const temp = temporaryPassword();
  const hash = await bcrypt.hash(temp, config.bcryptCost);
  return db.tx(async (x) => {
    const user = await x.get(
      `UPDATE users SET password_hash = ?, has_password = true, must_change_password = true,
              temp_password_expires_at = now() + make_interval(hours => ?),
              session_version = session_version + 1, password_changed_at = now()
       WHERE id = ? RETURNING id, name, email, is_active, temp_password_expires_at`,
      [hash, TEMP_HOURS, id],
    );
    if (!user) throw new AppError(404, 'Person not found');
    await notify(id, 'Your password was reset by the timetable office. If you did not ask for this, tell them straight away.', x);
    await audit({ userId: admin.id, action: 'user.reset_password', entity: 'user', entityId: id, ip }, x);
    return { temporaryPassword: temp, expiresAt: user.temp_password_expires_at, isActive: user.is_active };
  });
}

module.exports = { ROLES, list, update, resetPassword, temporaryPassword };
