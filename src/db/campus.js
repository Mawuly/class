'use strict';
// The campus's buildings and rooms.
//
// "ucc" is the University of Cape Coast, from the Directorate of Academic Affairs teaching
// timetables. Seat counts are estimates: the university does not publish them, so the timetable
// office should correct them in /admin → Rooms. Buildings listed without numbered rooms (e.g.
// the Faculty of Education) are created empty, for the office to add rooms with "+ Room here".
//
// "demo" is the small made-up campus the automated tests use.

const range = (n, from = 1) => Array.from({ length: n }, (_, i) => i + from);

const UCC_BUILDINGS = [
  ['NLT', 'New Lecture Theatre'],
  ['SWLT', 'Sandwich Lecture Theatre'],
  ['CALC', 'C. A. Ackah Lecture Theatre Complex'],
  ['LT', 'Science Lecture Theatre'],
  ['LLT', 'S. K. Adjepong Lecture Theatre'],
  ['ELT', 'Faculty of Education Lecture Theatre'],
  ['GBLK', 'G-Block (Arts and Social Sciences)'],
  ['LAW', 'Faculty of Law'],
  ['CODE', 'College of Distance Education'],
  ['CRT', 'Cafe Roof Top'],
  ['AUD', 'University Main Auditorium'],
  ['SMS', 'School of Medical Sciences'],
  ['SOB', 'School of Business'],
  ['SRT', 'Science Roof Top'],
  ['AHA', 'Assembly Hall Annex'],
];

// [building, code, name, type, seats (estimate), floor, facilities, who can book]
// Numbered lecture rooms: everyone (student requests still need approval). Auditoriums: staff only.
const UCC_ROOMS = [
  ...range(20).map((n) => ['NLT', `NLT-${n}`, `NLT ${n}`, 'lecture_hall', 200, 0, [], 'all']),
  ...range(19).map((n) => ['SWLT', `SW-${n}`, `SW ${n}`, 'lecture_hall', 150, 0, [], 'all']),
  ...range(12).map((n) => ['CALC', `CAC-${n}`, `CAC ${n}`, 'lecture_hall', 200, 0, [], 'all']),
  ['CALC', 'CALC-AUD', 'Auditorium 900', 'lecture_hall', 900, 0, [], 'staff'],
  ...range(22).map((n) => ['LT', `LT-${n}`, `LT ${n}`, 'lecture_hall', 150, 0, [], 'all']),
  ['LLT', 'LLT', 'S. K. Adjepong Auditorium', 'lecture_hall', 1000, 0, [], 'staff'],
  ...range(26).map((n) => ['GBLK', `G${n}`, `G${n}`, 'lecture_hall', 100, 0, [], 'all']),
  ['LAW', 'LLR-1', 'Law Lecture Room 1', 'lecture_hall', 120, 0, [], 'all'],
  ['LAW', 'LLR-2', 'Law Lecture Room 2', 'lecture_hall', 120, 0, [], 'all'],
  ...range(3).map((n) => ['CODE', `CODE-C${n}`, `CoDE C${n}`, 'lecture_hall', 200, 0, [], 'all']),
  ...range(4).map((n) => ['CRT', `CRT-${n}`, `CRT ${n}`, 'lecture_hall', 100, 0, [], 'all']),
  ['AUD', 'MAIN-AUD', 'University Main Auditorium', 'lecture_hall', 1500, 0, [], 'staff'],
  ['SMS', 'SMS-AUD', 'SMS Auditorium', 'lecture_hall', 400, 0, [], 'staff'],
];

const DEMO_BUILDINGS = [
  ['LTB', 'Lecture Theatre Block'],
  ['SCB', 'Science Block'],
  ['NAB', 'New Academic Block'],
  ['LIB', 'Main Library'],
];

const staffOnly = (type) => (type === 'lecture_hall' || type === 'lab' ? 'staff' : 'all');
const DEMO_ROOMS = [
  ['LTB', 'LT-1', 'Lecture Theatre 1', 'lecture_hall', 300, 0, ['projector', 'pa_system', 'ac']],
  ['LTB', 'LT-2', 'Lecture Theatre 2', 'lecture_hall', 200, 0, ['projector', 'pa_system', 'ac']],
  ['LTB', 'LT-3', 'Lecture Theatre 3', 'lecture_hall', 120, 1, ['projector', 'whiteboard']],
  ['SCB', 'SCB-101', 'Computer Lab 1', 'lab', 60, 1, ['computers', 'projector', 'ac']],
  ['SCB', 'SCB-104', 'Seminar Room 104', 'seminar', 40, 1, ['projector', 'whiteboard']],
  ['SCB', 'SCB-105', 'Seminar Room 105', 'seminar', 30, 1, ['whiteboard']],
  ['SCB', 'SCB-201', 'Science Lecture Hall', 'lecture_hall', 150, 2, ['projector', 'pa_system']],
  ['SCB', 'SCB-210', 'Physics Lab', 'lab', 45, 2, ['whiteboard']],
  ['NAB', 'NAB-001', 'Great Hall', 'lecture_hall', 250, 0, ['projector', 'pa_system', 'ac']],
  ['NAB', 'NAB-104', 'Seminar Room 104', 'seminar', 50, 1, ['projector', 'whiteboard', 'ac']],
  ['NAB', 'NAB-205', 'Meeting Room A', 'meeting', 12, 2, ['video_conf', 'whiteboard', 'ac']],
  ['NAB', 'NAB-206', 'Meeting Room B', 'meeting', 16, 2, ['projector', 'ac']],
  ['LIB', 'LIB-S1', 'Study Room 1', 'study', 6, 1, ['whiteboard']],
  ['LIB', 'LIB-S2', 'Study Room 2', 'study', 8, 1, ['whiteboard']],
  ['LIB', 'LIB-S3', 'Library Seminar 3', 'seminar', 20, 2, ['projector', 'whiteboard']],
  ['LIB', 'LIB-G1', 'Group Study Pod', 'study', 10, 0, ['whiteboard', 'ac']],
].map((r) => [...r, staffOnly(r[3])]);

const CAMPUSES = {
  ucc: { buildings: UCC_BUILDINGS, rooms: UCC_ROOMS },
  demo: { buildings: DEMO_BUILDINGS, rooms: DEMO_ROOMS },
};

/** Adds a campus's buildings and rooms, skipping any code that already exists. */
async function loadCampus(db, name) {
  const campus = CAMPUSES[name] || CAMPUSES.ucc;
  for (const [code, bname] of campus.buildings) {
    await db.run('INSERT INTO buildings (code, name) VALUES (?, ?) ON CONFLICT (code) DO NOTHING', [code, bname]);
  }
  for (const [b, code, rname, type, capacity, floor, facilities, bookableBy] of campus.rooms) {
    await db.run(
      `INSERT INTO rooms (building_id, code, name, type, capacity, floor, facilities, bookable_by)
       VALUES ((SELECT id FROM buildings WHERE code = ?), ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING`,
      [b, code, rname, type, capacity, floor, JSON.stringify(facilities), bookableBy],
    );
  }
}

/**
 * A database first set up with the demo campus moves to the real one, once. Demo rooms that were
 * never booked are deleted. Booked ones keep their history: they are renamed DEMO-…, so their codes
 * are free for the real rooms, and hidden unless something is still booked in them. Empty demo
 * buildings are deleted. Rooms the timetable office added itself are never touched.
 * Returns what changed, for the log.
 */
async function switchToCampus(db, name) {
  const out = { deleted: 0, retired: 0, kept: 0 };
  if (name !== 'demo') {
    for (const [b, code] of DEMO_ROOMS) {
      const room = await db.get(
        `SELECT r.id,
                (SELECT count(*)::int FROM bookings WHERE room_id = r.id) AS total,
                (SELECT count(*)::int FROM bookings WHERE room_id = r.id AND status IN ('pending', 'approved')
                   AND (date > current_date OR (date = current_date AND end_time > localtime))) AS upcoming
         FROM rooms r JOIN buildings bl ON bl.id = r.building_id
         WHERE r.code = ? AND bl.code = ?`,
        [code, b],
      );
      if (!room) continue;
      if (!room.total) {
        await db.run('DELETE FROM rooms WHERE id = ?', [room.id]);
        out.deleted += 1;
      } else {
        await db.run(
          `UPDATE rooms SET code = 'DEMO-' || code, name = name || ' (demo)', is_active = (? > 0) WHERE id = ?`,
          [room.upcoming, room.id],
        );
        if (room.upcoming) out.kept += 1; else out.retired += 1;
      }
    }
    for (const [code] of DEMO_BUILDINGS) {
      await db.run('DELETE FROM buildings b WHERE code = ? AND NOT EXISTS (SELECT 1 FROM rooms WHERE building_id = b.id)', [code]);
    }
  }
  await loadCampus(db, name);
  return out;
}

module.exports = { CAMPUSES, loadCampus, switchToCampus };
