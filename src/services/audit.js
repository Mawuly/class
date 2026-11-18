'use strict';
const db = require('../db');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');

/** Appends one entry. The log is append-only: the database refuses updates and deletes. */
async function audit({ userId = null, action, entity = null, entityId = null, details = null, ip = null }, exec = db) {
  await exec.run(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, action, entity, entityId, details == null ? null : JSON.stringify(details), ip],
  );
}

// Filter groups shown on the audit page.
const GROUPS = {
  security: ['auth.%', 'calendar.%', 'phone.%', 'user.reset_password', 'user.role_change', 'user.deactivate', 'user.reactivate', 'user.promote_admin', 'access.%'],
  failed: ['auth.login_failed'],
  bookings: ['booking.%', 'series.%'],
  rooms: ['room.%', 'building.%', 'settings.%'],
  people: ['user.%', 'access.%', 'auth.register'],
};

const MAX_PAGE = 200;
const MAX_EXPORT = 5000;

const day = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const ROLE = { student: 'student', lecturer: 'lecturer', admin: 'admin' };

/**
 * One sentence for each entry, written once here so the page and the CSV say the same thing.
 * Returns { who, summary, detail }.
 */
function describe(e) {
  const who = e.actor_name || (e.action === 'auth.login_failed' ? 'Someone' : 'Unknown');
  const person = e.target_user_name || 'someone';
  const booking = e.target_room ? `${e.target_room}${e.target_date ? ` on ${day(e.target_date)}${e.target_start ? ` at ${e.target_start}` : ''}` : ''}` : 'a booking';
  const d = e.details || {};
  const owner = e.target_owner_name && e.target_owner_name !== e.actor_name ? `${e.target_owner_name}'s ` : '';
  const S = {
    'auth.login': ['signed in', d.via === 'google' ? 'with Google' : ''],
    'auth.login_failed': [d.reason === 'temporary password expired' ? 'tried an expired temporary password' : 'failed to sign in',
      d.email ? `as ${d.email}` : ''],
    'user.update_self': ['updated their profile', Object.keys(d).join(', ').replace('index_number', 'index number')],
    'auth.sign_out_others': ['signed out their other devices'],
    'auth.register': ['created an account', d.via === 'google' ? 'with Google' : ''],
    'auth.google_linked': ['linked their Google account', 'old password no longer works'],
    'auth.change_password': ['changed their password', d.after ? 'after a reset' : ''],
    'auth.reset_requested': ['said they forgot their password'],
    'auth.reset_code_sent': [d.channel === 'sms' ? 'was texted a password reset code' : 'was emailed a password reset code'],
    'phone.code_sent': ['asked for a code to confirm a phone number'],
    'phone.verified': ['confirmed their phone number'],
    'phone.removed': ['removed their phone number'],
    'auth.reset_code_throttled': ['asked for another reset code too soon', 'no code sent'],
    'auth.reset_code_failed': ['could not be emailed a reset code', d.error || ''],
    'auth.reset_code_wrong': ['entered a wrong reset code', d.attempt ? `attempt ${d.attempt} of 5` : ''],
    'auth.reset_with_code': ['reset their password with a code'],
    'user.reset_password': [`reset ${person}'s password`],
    'user.role_change': [`made ${person} ${ROLE[d.role] === 'admin' ? 'an' : 'a'} ${ROLE[d.role] || d.role}`, d.from ? `was ${d.from}` : ''],
    'user.update': [`updated ${person}'s details`],
    'user.deactivate': [`deactivated ${person}'s account`, d.cancelled ? `${d.cancelled} booking${d.cancelled === 1 ? '' : 's'} cancelled` : ''],
    'user.reactivate': [`reactivated ${person}'s account`],
    'user.promote_admin': ['became an admin', 'listed in ADMIN_EMAILS'],
    'booking.create': [`booked ${booking}`, d.status === 'pending' ? 'request, awaiting approval' : ''],
    'booking.cancel': [`cancelled ${owner || 'their '}booking for ${booking}`],
    'booking.check_in': [`checked in to ${owner || 'their '}booking for ${booking}`,
      [d.via === 'qr' ? 'scanned the door QR code' : 'typed the door code', {
        near: 'at the building',
        far: `⚠ ${d.distance_m >= 1000 ? `${(d.distance_m / 1000).toFixed(1)} km` : `${d.distance_m} m`} from the building`,
        unknown: '⚠ location not shared',
        unchecked: 'building location not set',
      }[d.location]].filter(Boolean).join(' · ')],
    'booking.check_out': [`checked out of ${owner || 'their '}booking for ${booking}`, d.end ? `room free from ${d.end}` : 'the rest of the room is free'],
    'booking.check_in_refused': [`was refused check-in to ${owner || 'their '}booking for ${booking}`,
      d.location === 'far' ? `⚠ ${d.distance_m >= 1000 ? `${(d.distance_m / 1000).toFixed(1)} km` : `${d.distance_m} m`} from the building`
        : d.accuracy_m ? `location too imprecise (±${d.accuracy_m} m)` : 'location not shared'],
    'timetable.import': [`imported the timetable "${d.label}"`, `${d.classes} classes, ${d.lectures} lectures ${d.from ? `${day(d.from)} – ${day(d.to)}` : ''}`.trim()],
    'timetable.remove': [`removed the timetable "${d.label}"`, `${d.cancelled} lectures cancelled`],
    'room.new_door_code': [`replaced the door code of ${e.target_room || 'a room'}`, 'the old sign stopped working'],
    'booking.approve': [`approved ${owner}request for ${booking}`],
    'booking.reject': [`rejected ${owner}request for ${booking}`, d.reason ? `“${d.reason}”` : ''],
    'series.create': [`booked ${d.weeks || ''} weeks in ${e.target_room || d.room || 'a room'}`.replace('  ', ' '),
      d.skipped?.length ? `skipped ${d.skipped.map(day).join(', ')}` : ''],
    'series.cancel': [`cancelled a weekly booking in ${e.target_room || 'a room'}`, d.cancelled ? `${d.cancelled} week${d.cancelled === 1 ? '' : 's'}` : ''],
    'room.create': [`added room ${e.target_room || d.code || ''}`.trim()],
    'room.update': [`edited room ${e.target_room || ''}`.trim(), Object.keys(d).filter((k) => k !== 'cancelled').join(', ')],
    'room.deactivate': [`deactivated room ${e.target_room || ''}`.trim(), d.cancelled ? `${d.cancelled} booking${d.cancelled === 1 ? '' : 's'} cancelled` : ''],
    'room.reactivate': [`reactivated room ${e.target_room || ''}`.trim()],
    'room.delete': [`deleted room ${d.code || ''}`.trim()],
    'room.block': [`closed ${e.target_room || 'a room'} on ${d.date ? day(d.date) : ''} ${d.start || ''}–${d.end || ''}`.replace(/\s+/g, ' ').trim(), d.reason ? `“${d.reason}”` : ''],
    'room.unblock': [`made ${e.target_room || 'a room'} available again on ${d.date ? day(d.date) : ''} ${d.start || ''}–${d.end || ''}`.replace(/\s+/g, ' ').trim(), d.reason ? `was closed for “${d.reason}”` : ''],
    'settings.update': ['changed the booking window', Object.entries(d).map(([k, v]) => `${{ open: 'opens', close: 'closes', maxHours: 'longest booking', checkInLocation: 'check-in location', studentApproval: 'student requests', eventClose: 'event rooms close', eventMaxHours: 'longest event booking' }[k] || k} ${v.from} → ${v.to}${k === 'maxHours' ? ' h' : ''}`).join(', ')],
    'booking.check_out': [`checked out of ${owner || 'their '}booking for ${booking} early`, d.ended ? `left at ${d.ended}, booked until ${d.planned_end}` : ''],
    'building.create': [`added building ${e.target_building || d.code || ''}`.trim()],
    'building.update': [`edited building ${e.target_building || d.code || ''}`.trim()],
    'building.delete': [`deleted building ${d.code || ''}`.trim()],
    'settings.update': ['changed the booking window',
      d.before ? `${d.open}–${d.close}, up to ${d.maxHours} hours (was ${d.before.open}–${d.before.close}, ${d.before.maxHours} hours)` : ''],
    'calendar.create_link': ['created a calendar subscription link'],
    'calendar.replace_link': ['replaced their calendar subscription link', 'the old link stopped working'],
    'calendar.remove_link': ['turned off their calendar subscription link'],
    'access.request': [`asked for ${d.role === 'admin' ? 'admin' : 'lecturer'} access`, 'letter attached'],
    'access.approve': [`gave ${e.target_access_name || 'someone'} ${d.role === 'admin' ? 'admin' : 'lecturer'} access`,
      d.letter_sha256 ? `letter ${d.letter_sha256.slice(0, 12)}…, deleted` : ''],
    'access.reject': [`refused ${e.target_access_name || 'someone'}'s ${d.role === 'admin' ? 'admin' : 'lecturer'} access request`,
      d.reason ? `“${d.reason}”` : ''],
  }[e.action] || [e.action.replace('.', ' ')];
  // A failed sign-in is logged against the account that was tried, but whoever typed the
  // password may not be its owner, so it isn't phrased as something they did.
  if (e.action === 'auth.login_failed') {
    const what = d.reason === 'temporary password expired' ? 'Expired temporary password used' : 'Failed sign-in';
    return e.actor_name
      ? { who: e.actor_name, summary: `${what} to ${e.actor_name}'s account`, detail: '' }
      : { who: 'Unknown', summary: `${what} for an unknown email`, detail: d.email ? `tried ${d.email}` : '' };
  }
  // Releases are done by the system, not a person.
  if (e.action === 'booking.release') {
    const whose = e.target_owner_name ? `${e.target_owner_name}'s booking` : 'A booking';
    return { who: 'System', summary: `${whose} for ${booking} was released`, detail: d.by ? `nobody checked in by ${d.by}` : 'nobody checked in' };
  }
  return { who, summary: `${who} ${S[0]}`, detail: S[1] || '' };
}

/**
 * Entries newest first, each joined to who did it and what it was about, so the page can
 * describe it in words. Filters: group, q (a person's name or email), from / to (dates),
 * before (an entry id, for "load older").
 */
async function list(query = {}, { limit = 100, max = MAX_PAGE } = {}) {
  const where = [];
  const args = [];
  const group = GROUPS[query.group];
  if (query.group && query.group !== 'all' && !group) throw new AppError(400, 'Unknown filter');
  if (group) {
    where.push(`(${group.map(() => 'a.action LIKE ?').join(' OR ')})`);
    args.push(...group);
  }
  const term = String(query.q || '').trim().toLowerCase().slice(0, 80);
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // The person who acted, or the person it was about.
    where.push('(lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR lower(tu.name) LIKE ? OR lower(tu.email) LIKE ? OR a.details->>\'email\' LIKE ?)');
    args.push(like, like, like, like, like);
  }
  for (const [key, op] of [['from', '>='], ['to', '<']]) {
    if (!query[key]) continue;
    if (!t.isValidDate(query[key])) throw new AppError(400, 'Dates must be valid (YYYY-MM-DD)');
    // "to" includes the whole of that day.
    where.push(`a.created_at ${op} (?::date::timestamp${key === 'to' ? " + interval '1 day'" : ''}) AT TIME ZONE 'Africa/Accra'`);
    args.push(query[key]);
  }
  const before = Number(query.before);
  if (query.before && (!Number.isInteger(before) || before < 1)) throw new AppError(400, 'Invalid page');
  if (before) { where.push('a.id < ?'); args.push(before); }
  const size = Math.min(max, Math.max(1, Number(limit) || 100));

  const rows = await db.all(
    `SELECT a.id, a.created_at, a.action, a.entity, a.entity_id, a.details, a.ip,
            u.id AS actor_id, u.name AS actor_name, u.email AS actor_email, u.role AS actor_role,
            tu.name AS target_user_name, tu.email AS target_user_email,
            coalesce(r.code, br.code, sr.code) AS target_room,
            to_char(b.date, 'YYYY-MM-DD') AS target_date, to_char(b.start_time, 'HH24:MI') AS target_start,
            bo.name AS target_owner_name, bl.code AS target_building,
            ar.role AS target_access_role, aru.name AS target_access_name
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN users tu ON a.entity = 'user' AND tu.id = a.entity_id
     LEFT JOIN rooms r ON a.entity = 'room' AND r.id = a.entity_id
     LEFT JOIN bookings b ON a.entity = 'booking' AND b.id = a.entity_id
     LEFT JOIN rooms br ON br.id = b.room_id
     LEFT JOIN users bo ON bo.id = b.user_id
     LEFT JOIN booking_series s ON a.entity = 'booking_series' AND s.id = a.entity_id
     LEFT JOIN rooms sr ON sr.id = s.room_id
     LEFT JOIN buildings bl ON a.entity = 'building' AND bl.id = a.entity_id
     LEFT JOIN access_requests ar ON a.entity = 'access_request' AND ar.id = a.entity_id
     LEFT JOIN users aru ON aru.id = ar.user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.id DESC LIMIT ?`,
    [...args, size + 1],
  );
  const more = rows.length > size;
  const entries = rows.slice(0, size).map((e) => ({
    id: e.id, created_at: e.created_at, action: e.action, ip: e.ip,
    actor: e.actor_id ? { id: e.actor_id, name: e.actor_name, email: e.actor_email, role: e.actor_role } : null,
    ...describe(e),
  }));
  return { entries, nextBefore: more ? entries[entries.length - 1].id : null };
}

/** The security panel: failed sign-ins in the last 24 hours, and from how many addresses. */
async function securitySummary() {
  return db.get(
    `SELECT count(*)::int AS failed_24h,
            count(DISTINCT ip)::int AS failed_ips_24h,
            count(DISTINCT details->>'email')::int AS failed_emails_24h,
            (SELECT count(*)::int FROM audit_log WHERE action = 'auth.login' AND created_at > now() - interval '24 hours') AS logins_24h
     FROM audit_log WHERE action = 'auth.login_failed' AND created_at > now() - interval '24 hours'`,
  );
}

/** The filtered log as CSV, newest first, at most 5,000 entries. */
async function csv(query) {
  const { entries } = await list({ ...query, before: undefined }, { limit: MAX_EXPORT, max: MAX_EXPORT });
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Time (Accra)', 'Who', 'Email', 'Role', 'What happened', 'Details', 'Action code', 'IP address'].map(cell).join(',')];
  for (const e of entries) {
    const when = new Date(e.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Accra', dateStyle: 'medium', timeStyle: 'medium' });
    lines.push([when, e.who, e.actor?.email, e.actor?.role, e.summary, e.detail, e.action, e.ip].map(cell).join(','));
  }
  return `\ufeff${lines.join('\r\n')}`;
}

module.exports = { audit, list, csv, describe, securitySummary, GROUPS };
