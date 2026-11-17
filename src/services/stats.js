'use strict';
// Usage statistics for the timetable office.
//
// Utilisation = hours booked ÷ hours available, where "available" is every active room from
// opening to closing time on each teaching day (Monday-Friday) in the range.
// Only approved bookings count: pending requests hold a slot but haven't been confirmed.
const db = require('../db');
const { booking: rules } = require('../config');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');

const MAX_DAYS = 366;

function parseRange({ from, to }) {
  const today = t.localDate();
  const end = to || today;
  const start = from || t.addDays(end, -29);
  if (!t.isValidDate(start) || !t.isValidDate(end)) throw new AppError(400, 'Dates must be valid (YYYY-MM-DD)');
  if (start > end) throw new AppError(400, 'The start date must be on or before the end date');
  const days = t.daysBetween(start, end) + 1;
  if (days > MAX_DAYS) throw new AppError(400, `Choose a range of at most ${MAX_DAYS} days`);
  return { from: start, to: end, days };
}

function teachingDays(from, to) {
  let n = 0;
  for (let d = from; d <= to; d = t.addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) n += 1;
  }
  return n;
}

/** Headline numbers for one range. Used for the chosen range and the one before it. */
async function headline(range, buildingId) {
  const bFilter = buildingId ? 'AND r.building_id = ?' : '';
  const args = [range.from, range.to, ...(buildingId ? [buildingId] : [])];
  const { rooms } = await db.get(
    `SELECT count(*)::int AS rooms FROM rooms r WHERE r.is_active ${bFilter}`,
    buildingId ? [buildingId] : [],
  );
  const row = await db.get(
    `SELECT count(*) FILTER (WHERE b.status = 'approved')::int AS bookings,
            coalesce(sum(extract(epoch FROM b.end_time - b.start_time) / 60) FILTER (WHERE b.status = 'approved'), 0)::int AS minutes,
            count(*) FILTER (WHERE b.status = 'cancelled')::int AS cancelled
     FROM bookings b JOIN rooms r ON r.id = b.room_id
     WHERE b.date BETWEEN ? AND ? ${bFilter}`,
    args,
  );
  const tdays = teachingDays(range.from, range.to);
  const available = rooms * tdays * (t.toMinutes(rules.close) - t.toMinutes(rules.open));
  return {
    rooms,
    teachingDays: tdays,
    bookings: row.bookings,
    hours: Math.round((row.minutes / 60) * 10) / 10,
    utilisation: available ? row.minutes / available : 0,
    cancelled: row.cancelled,
  };
}

/** Everything the statistics page shows, for one date range (and optionally one building). */
async function overview(query) {
  const range = parseRange(query);
  const buildingId = query.buildingId ? Number(query.buildingId) : null;
  if (buildingId !== null && (!Number.isInteger(buildingId) || buildingId < 1)) throw new AppError(400, 'Unknown building');
  const bFilter = buildingId ? 'AND r.building_id = ?' : '';
  const bArg = buildingId ? [buildingId] : [];
  const openMins = t.toMinutes(rules.close) - t.toMinutes(rules.open);

  // The same-length period just before, for "compared with" figures.
  const prevTo = t.addDays(range.from, -1);
  const previousRange = { from: t.addDays(prevTo, -(range.days - 1)), to: prevTo, days: range.days };

  const [current, previous, rooms, hours, categories, requests] = await Promise.all([
    headline(range, buildingId),
    headline(previousRange, buildingId),
    db.all(
      `SELECT r.id, r.code, r.name, r.type, r.capacity, bl.code AS building_code,
              count(b.id)::int AS bookings,
              coalesce(sum(extract(epoch FROM b.end_time - b.start_time) / 60), 0)::int AS minutes,
              coalesce(avg(b.attendees::float / r.capacity), 0) AS avg_fill
       FROM rooms r JOIN buildings bl ON bl.id = r.building_id
       LEFT JOIN bookings b ON b.room_id = r.id AND b.status = 'approved' AND b.date BETWEEN ? AND ?
       WHERE r.is_active ${bFilter}
       GROUP BY r.id, bl.code ORDER BY minutes DESC, r.code`,
      [range.from, range.to, ...bArg],
    ),
    // Room-minutes booked inside each clock hour, summed over the range. The FILTER matters:
    // LEAST/GREATEST ignore NULLs, so an hour with no booking would otherwise count as 60 minutes.
    db.all(
      `SELECT h.hour::int AS hour,
              coalesce(sum(greatest(0, extract(epoch FROM
                least(b.end_time, make_time(h.hour + 1, 0, 0)) - greatest(b.start_time, make_time(h.hour, 0, 0))) / 60))
                FILTER (WHERE b.id IS NOT NULL), 0)::int AS minutes
       FROM generate_series(?::int, ?::int) AS h(hour)
       LEFT JOIN (bookings b JOIN rooms r ON r.id = b.room_id AND r.is_active ${bFilter})
         ON b.status = 'approved' AND b.date BETWEEN ? AND ?
            AND b.start_time < make_time(h.hour + 1, 0, 0) AND b.end_time > make_time(h.hour, 0, 0)
       GROUP BY h.hour ORDER BY h.hour`,
      [Math.floor(t.toMinutes(rules.open) / 60), Math.ceil(t.toMinutes(rules.close) / 60) - 1, ...bArg, range.from, range.to],
    ),
    db.all(
      `SELECT b.category, count(*)::int AS bookings,
              sum(extract(epoch FROM b.end_time - b.start_time) / 60)::int AS minutes
       FROM bookings b JOIN rooms r ON r.id = b.room_id
       WHERE b.status = 'approved' AND b.date BETWEEN ? AND ? ${bFilter}
       GROUP BY b.category ORDER BY minutes DESC, b.category`,
      [range.from, range.to, ...bArg],
    ),
    // Requests that needed a decision: student requests (pending, or decided by an admin).
    db.get(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE b.status = 'pending')::int AS pending,
              -- Approved, including approvals that were cancelled afterwards.
              count(*) FILTER (WHERE b.decided_by IS NOT NULL AND b.status <> 'rejected')::int AS approved,
              count(*) FILTER (WHERE b.status = 'rejected')::int AS rejected,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM b.updated_at - b.created_at) / 3600)
                FILTER (WHERE b.decided_by IS NOT NULL) AS median_hours
       FROM bookings b JOIN rooms r ON r.id = b.room_id
       WHERE (b.status = 'pending' OR b.decided_by IS NOT NULL) AND b.date BETWEEN ? AND ? ${bFilter}`,
      [range.from, range.to, ...bArg],
    ),
  ]);

  const attendance = await attendanceFor(range, bFilter, bArg);
  const perRoomAvailable = current.teachingDays * openMins;
  return {
    range: { ...range, teachingDays: current.teachingDays, open: rules.open, close: rules.close },
    previousRange,
    current,
    previous,
    requests: {
      total: requests.total,
      pending: requests.pending,
      approved: requests.approved,
      rejected: requests.rejected,
      medianDecisionHours: requests.median_hours == null ? null : Math.round(Number(requests.median_hours) * 10) / 10,
    },
    rooms: rooms.map((r) => ({
      ...r,
      hours: Math.round((r.minutes / 60) * 10) / 10,
      utilisation: perRoomAvailable ? r.minutes / perRoomAvailable : 0,
      avg_fill: Math.round(Number(r.avg_fill) * 100) / 100,
    })),
    hours: hours.map((h) => ({ hour: h.hour, hours: Math.round((h.minutes / 60) * 10) / 10 })),
    categories: categories.map((c) => ({ ...c, hours: Math.round((c.minutes / 60) * 10) / 10 })),
    attendance,
  };
}

/**
 * Check-in for bookings whose check-in time is over: how many were checked in, released
 * (nobody came, the room was freed) or missed (ended without check-in, e.g. approved late or
 * with releasing turned off). Only counts bookings from the day check-in started.
 */
async function attendanceFor(range, bFilter, bArg) {
  const since = (await db.get("SELECT value FROM app_meta WHERE key = 'checkin_since'"))?.value || range.from;
  const now = new Date();
  const today = t.localDate(now);
  const graceAgo = t.localTime(new Date(now.getTime() - rules.checkInGraceMinutes * 60_000));
  const from = range.from > since ? range.from : since;
  const row = await db.get(
    `SELECT count(*) FILTER (WHERE b.checked_in_at IS NOT NULL)::int AS checked_in,
            count(*) FILTER (WHERE b.status = 'released')::int AS released,
            count(*) FILTER (WHERE b.status = 'approved' AND b.checked_in_at IS NULL)::int AS missed,
            count(*) FILTER (WHERE b.checkin_location = 'near')::int AS near,
            count(*) FILTER (WHERE b.checkin_location = 'far')::int AS far,
            count(*) FILTER (WHERE b.checkin_location = 'unknown')::int AS unknown,
            count(*) FILTER (WHERE b.checkin_location = 'unchecked')::int AS unchecked
     FROM bookings b JOIN rooms r ON r.id = b.room_id
     WHERE b.status IN ('approved', 'released') AND b.parent_id IS NULL AND b.date BETWEEN ? AND ?
       AND (b.checked_in_at IS NOT NULL OR b.date < ? OR (b.date = ? AND b.start_time <= ?)) ${bFilter}`,
    [from, range.to, today, today, graceAgo, ...bArg],
  );
  const total = row.checked_in + row.released + row.missed;
  // Check-ins the location check flagged: away from the building, or no location shared.
  const flagged = await db.all(
    `SELECT b.id, b.date, b.start_time, b.end_time, b.checked_in_at, b.checkin_location AS location,
            b.checkin_distance_m AS distance_m, r.code AS room_code, u.name AS user_name, u.email AS user_email
     FROM bookings b JOIN rooms r ON r.id = b.room_id JOIN users u ON u.id = b.user_id
     WHERE b.checkin_location IN ('far', 'unknown') AND b.date BETWEEN ? AND ? ${bFilter}
     ORDER BY b.checked_in_at DESC LIMIT 50`,
    [from, range.to, ...bArg],
  );
  const { unset } = await db.get(
    `SELECT count(DISTINCT bl.id)::int AS unset FROM buildings bl JOIN rooms r ON r.building_id = bl.id
     WHERE r.is_active AND (bl.latitude IS NULL OR bl.longitude IS NULL) ${bFilter}`,
    bArg,
  );
  return {
    location: { near: row.near, far: row.far, unknown: row.unknown, unchecked: row.unchecked, buildingsWithoutLocation: unset, flagged },
    since,
    graceMinutes: rules.checkInGraceMinutes,
    releasing: rules.releaseNoShows,
    total,
    checkedIn: row.checked_in,
    released: row.released,
    missed: row.missed,
    rate: total ? row.checked_in / total : null,
  };
}

module.exports = { overview, teachingDays, parseRange };
