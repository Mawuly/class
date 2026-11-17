'use strict';
// The official teaching timetable. The timetable office pastes a programme's timetable (one row per
// weekly class) and the semester's first and last teaching days; every class becomes a weekly booking
// of kind 'timetable', owned by the office. A class shows as booked; anyone signed in at the building
// can check it in; if nobody does within the grace period, the room is released and shows as free.
const db = require('../db');
const { AppError } = require('../utils/errors');
const t = require('../utils/time');
const { audit } = require('./audit');
const { naturalCode } = require('../utils/sort');

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HOLDING = "('pending', 'approved')";
const MAX_ROWS = 300;
const MAX_WEEKS = 26;

/** "9:30 AM", "9:30am", "09:30", "21:30" → "09:30"; null when it isn't a time. */
function parseTime(raw) {
  const m = String(raw ?? '').trim().toLowerCase().replace(/\./g, '').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return t.fromMinutes(h * 60 + min);
}

/** One CSV line into cells (handles "quoted, cells" and "" inside quotes). */
function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\t') { cells.push(cur.trim()); cur = ''; } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const COLUMNS = {
  day: ['day'], start: ['start', 'from', 'start time'], end: ['end', 'to', 'end time'], time: ['time'],
  code: ['code', 'course code'], title: ['title', 'course', 'course title'], room: ['room', 'location', 'venue'],
  lecturer: ['lecturer', 'lecturers', 'teacher'],
};

/**
 * The pasted table: a header row, then one class per row. Columns (any order, case-insensitive):
 * Day, Start, End (or one Time column like "9:30 AM – 11:30 AM"), Code, Title, Room, Lecturer.
 * A day may be left empty to repeat the row above. Commas or tabs separate the columns.
 */
function parseTable(text) {
  // Only trailing space is trimmed: an empty first cell ("same day as above") must stay a cell.
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  if (lines.length < 2) throw new AppError(400, 'Paste a header row and at least one class');
  if (lines.length > MAX_ROWS + 1) throw new AppError(400, `At most ${MAX_ROWS} classes at once`);
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
  if (col.day < 0 || col.room < 0 || (col.time < 0 && (col.start < 0 || col.end < 0))) {
    throw new AppError(400, 'The header row needs Day, Room and either Start and End or Time');
  }
  let lastDay = null;
  return lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line);
    const get = (k) => (col[k] >= 0 ? (cells[col[k]] ?? '').trim() : '');
    const dayRaw = get('day') || lastDay || '';
    lastDay = dayRaw;
    let [startRaw, endRaw] = [get('start'), get('end')];
    if (col.time >= 0 && get('time')) [startRaw, endRaw] = get('time').split(/\s*(?:–|—|-|to)\s*/i);
    return {
      line: i + 2,
      day: DAYS[dayRaw.slice(0, 3).toLowerCase()] ?? null,
      dayRaw,
      start: parseTime(startRaw),
      end: parseTime(endRaw),
      code: get('code').toUpperCase().slice(0, 20) || null,
      title: get('title').slice(0, 120),
      roomRaw: get('room'),
      lecturer: get('lecturer').slice(0, 120) || null,
    };
  });
}

/**
 * The room a timetable means: "NLT 10" → NLT-10, "SWLT 17" → SW-17, "CALC 2" → CAC-2, "LLT" → LLT.
 * Accepts the code inside brackets, e.g. "New Lecture Theater (NLT 10)".
 */
function roomCandidates(raw) {
  const inner = (String(raw).match(/\(([^)]+)\)/)?.[1] ?? String(raw)).trim().toUpperCase();
  const base = inner.replace(/\s+/g, '-').replace(/-+/g, '-');
  const out = new Set([base, base.replace(/-/g, '')]);
  const m = inner.match(/^([A-Z]+)\s*-?\s*(\d+)$/);
  if (m) {
    const alias = { SWLT: 'SW', CALC: 'CAC' }[m[1]] || m[1];
    out.add(`${alias}-${Number(m[2])}`);
    out.add(`${alias}${Number(m[2])}`);
  }
  return [...out];
}

function datesFor(weekday, from, to) {
  const out = [];
  let d = from;
  while ((new Date(`${d}T00:00:00Z`).getUTCDay()) !== weekday) d = t.addDays(d, 1);
  for (; d <= to && out.length < MAX_WEEKS; d = t.addDays(d, 7)) out.push(d);
  return out;
}

/**
 * Works out every class: which room, which dates, and what can't be booked. Changes nothing.
 * Returns { rows: [{ ...row, room, dates: [{ date, ok, reason }], problem }], from, to }.
 */
async function plan(exec, input) {
  const from = String(input.from ?? '');
  const to = String(input.to ?? '');
  if (!t.isValidDate(from) || !t.isValidDate(to)) throw new AppError(400, 'Give the first and last teaching days as dates');
  if (to < from) throw new AppError(400, 'The last teaching day is before the first');
  if (t.daysBetween(from, to) > MAX_WEEKS * 7) throw new AppError(400, `A timetable covers at most ${MAX_WEEKS} weeks`);
  const today = t.localDate();
  const label = String(input.label ?? '').trim().slice(0, 80);
  if (label.length < 2) throw new AppError(400, 'Name this timetable, e.g. "B.Com Management Level 300"');

  const rooms = await exec.all('SELECT id, code, name, capacity, is_active FROM rooms');
  const byCode = new Map(rooms.map((r) => [r.code.toUpperCase(), r]));
  const rows = parseTable(input.table);

  for (const row of rows) {
    row.dates = [];
    if (!row.roomRaw || /^[-—–]+$/.test(row.roomRaw)) { row.problem = 'No room given'; continue; }
    if (row.day == null) { row.problem = `"${row.dayRaw}" is not a day`; continue; }
    if (!row.start || !row.end) { row.problem = 'Start and end must be times, e.g. 9:30 AM'; continue; }
    if (row.end <= row.start) { row.problem = 'Ends before it starts'; continue; }
    if (t.toMinutes(row.start) % 30 || t.toMinutes(row.end) % 30) { row.problem = 'Times must be on the hour or half hour'; continue; }
    if (!row.title && !row.code) { row.problem = 'Give a course code or title'; continue; }
    row.room = roomCandidates(row.roomRaw).map((c) => byCode.get(c)).find(Boolean) || null;
    if (!row.room) { row.problem = `No room "${row.roomRaw}". Add it in Rooms, or use its code (e.g. NLT-10)`; continue; }
    if (!row.room.is_active) { row.problem = `${row.room.code} is deactivated`; continue; }

    for (const date of datesFor(row.day, from > today ? from : today, to)) {
      if (date === today && row.start <= t.localTime()) { row.dates.push({ date, ok: false, reason: 'already started' }); continue; }
      const busy = await exec.get(
        `SELECT b.start_time, b.end_time, coalesce(b.course_code, b.title) AS what FROM bookings b
         WHERE b.room_id = ? AND b.date = ? AND b.status IN ${HOLDING} AND b.start_time < ? AND b.end_time > ?
         UNION ALL
         SELECT rb.start_time, rb.end_time, 'unavailable: ' || rb.reason FROM room_blocks rb
         WHERE rb.room_id = ? AND rb.date = ? AND rb.start_time < ? AND rb.end_time > ?
         LIMIT 1`,
        [row.room.id, date, row.end, row.start, row.room.id, date, row.end, row.start],
      );
      row.dates.push(busy
        ? { date, ok: false, reason: `${row.room.code} has ${busy.what} ${busy.start_time}–${busy.end_time}` }
        : { date, ok: true });
    }
    if (!row.dates.length) row.problem = 'No teaching days left in this range';
  }
  return { from, to, label, rows };
}

const shape = (p) => ({
  label: p.label,
  from: p.from,
  to: p.to,
  rows: p.rows.map((r) => ({
    line: r.line, day: r.day == null ? r.dayRaw : DAY_NAMES[r.day], start: r.start, end: r.end, code: r.code, title: r.title,
    room: r.room?.code ?? r.roomRaw, lecturer: r.lecturer, problem: r.problem ?? null,
    weeks: r.dates.filter((d) => d.ok).length,
    skipped: r.dates.filter((d) => !d.ok),
  })),
});

async function preview(input) {
  return shape(await plan(db, input));
}

/** Books every class that can be booked, in one transaction. Clashing weeks are skipped and listed. */
async function importTimetable(admin, input, { ip } = {}) {
  return db.tx(async (x) => {
    const p = await plan(x, input);
    let lectures = 0;
    let classes = 0;
    for (const row of p.rows) {
      const ok = row.dates.filter((d) => d.ok);
      if (row.problem || !ok.length) continue;
      const series = await x.get(
        `INSERT INTO booking_series (user_id, room_id, weekday, start_time, end_time, first_date, last_date, kind, title, course_code, lecturer, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'timetable', ?, ?, ?, ?) RETURNING id`,
        [admin.id, row.room.id, row.day, row.start, row.end, ok[0].date, ok[ok.length - 1].date,
          row.title || row.code, row.code, row.lecturer, p.label],
      );
      for (const d of ok) {
        await x.run(
          `INSERT INTO bookings (room_id, user_id, title, category, course_code, lecturer, date, start_time, end_time,
                                 attendees, notes, status, series_id, kind)
           VALUES (?, ?, ?, 'lecture', ?, ?, ?, ?, ?, ?, ?, 'approved', ?, 'timetable')`,
          [row.room.id, admin.id, row.title || row.code, row.code, row.lecturer, d.date, row.start, row.end,
            row.room.capacity, p.label, series.id],
        );
      }
      lectures += ok.length;
      classes += 1;
    }
    if (!classes) throw new AppError(409, 'Nothing could be booked. Check the problems listed for each class.', shape(p));
    await audit({ userId: admin.id, action: 'timetable.import', details: { label: p.label, classes, lectures, from: p.from, to: p.to }, ip }, x);
    return { ...shape(p), classes, lectures };
  });
}

/** Imported timetables, one line per weekly class, with how many lectures are still to come. */
async function list() {
  const today = t.localDate();
  return db.all(
    `SELECT s.id, s.label, s.title, s.course_code, s.lecturer, s.weekday, s.start_time, s.end_time, s.first_date, s.last_date,
            r.code AS room_code,
            count(b.id) FILTER (WHERE b.status = 'approved' AND b.date >= ?)::int AS upcoming,
            count(b.id) FILTER (WHERE b.checked_in_at IS NOT NULL)::int AS checked_in,
            count(b.id) FILTER (WHERE b.status = 'released')::int AS released
     FROM booking_series s JOIN rooms r ON r.id = s.room_id LEFT JOIN bookings b ON b.series_id = s.id
     WHERE s.kind = 'timetable'
     GROUP BY s.id, r.code ORDER BY s.label, s.weekday, s.start_time, ${naturalCode('r.code')}`,
    [today],
  );
}

/** Takes a whole imported timetable off: every lecture still to come is cancelled. */
async function remove(admin, label, { ip } = {}) {
  const today = t.localDate();
  return db.tx(async (x) => {
    const { rows } = await x.run(
      `UPDATE bookings SET status = 'cancelled', updated_at = now()
       WHERE kind = 'timetable' AND status IN ${HOLDING} AND (date > ? OR (date = ? AND end_time > ?))
         AND series_id IN (SELECT id FROM booking_series WHERE kind = 'timetable' AND label = ?)
       RETURNING id`,
      [today, today, t.localTime(), label],
    );
    if (!rows.length) throw new AppError(404, 'No lectures of that timetable are still to come');
    await audit({ userId: admin.id, action: 'timetable.remove', details: { label, cancelled: rows.length }, ip }, x);
    return { cancelled: rows.length };
  });
}

module.exports = { parseTime, parseTable, roomCandidates, preview, importTimetable, list, remove };
