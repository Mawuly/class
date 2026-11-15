// The day board: rooms down the side, hours across the top, one day at a time.
// Click an empty slot to book it; drag across slots for a longer booking.
import { api } from './api.js';
import { openSheet } from './sheet.js';
import { $, $$, h, toMin, fromMin, isoDate, hhmm, addDays, showError } from './util.js';

const view = $('[data-view="board"]');
const boardEl = $('[data-board]', view);
const live = $('[data-board-live]', view);

const b = {
  ctx: null,          // { user, rules } from app.js
  date: null,         // 'YYYY-MM-DD'
  buildingId: '',     // '' = all buildings
  data: null,         // last /rooms/schedule/day response
  timers: [],
  drag: null,         // { track, row, from, to, lo, hi } while selecting
};

const SAVED_BUILDING = 'board.building';
function loadSaved() { try { return localStorage.getItem(SAVED_BUILDING) || ''; } catch { return ''; } }
function save(v) { try { localStorage.setItem(SAVED_BUILDING, v); } catch { /* private mode */ } }

/* ---------- Time geometry ----------------------------------------------------------- */

const open = () => toMin(b.ctx.rules.open);
const close = () => toMin(b.ctx.rules.close);
const step = () => b.ctx.rules.slotMinutes;
const slotCount = () => (close() - open()) / step();
const pct = (t) => ((toMin(t) - open()) / (close() - open())) * 100;
const slotStart = (i) => fromMin(open() + i * step());

/** The first slot that can still be booked today (start not in the past); 0 for future days. */
function firstBookableSlot() {
  const today = isoDate(new Date());
  if (b.date > today) return 0;
  if (b.date < today) return Infinity;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  return Math.max(0, Math.ceil((mins - open()) / step()));
}

/* ---------- Rendering --------------------------------------------------------------- */

function block(bk) {
  const label = `${bk.course_code ? `${bk.course_code} · ` : ''}${bk.title}`;
  const status = bk.status === 'pending' ? 'awaiting approval' : 'booked';
  return h('div', {
    class: `block block--${bk.status}${bk.mine ? ' block--mine' : ''}`,
    style: `left:${pct(bk.start_time)}%;width:${pct(bk.end_time) - pct(bk.start_time)}%`,
    title: `${label}\n${bk.start_time}–${bk.end_time} · ${status}${bk.mine ? ' · yours' : ''}`,
  },
  h('span', { class: 'block__title' }, bk.mine ? h('span', { 'aria-hidden': 'true' }, '■ ') : '', label),
  h('span', { class: 'block__time mono' }, `${bk.start_time}–${bk.end_time}`));
}

function row(room, bookings, bookableFrom) {
  const busy = new Array(slotCount()).fill(null);
  for (const bk of bookings) {
    const s = Math.max(0, Math.floor((toMin(bk.start_time) - open()) / step()));
    const e = Math.min(slotCount(), Math.ceil((toMin(bk.end_time) - open()) / step()));
    for (let i = s; i < e; i++) busy[i] = bk;
  }
  const bookable = room.canBook && bookableFrom < slotCount();
  const track = h('div', {
    class: `track${room.canBook ? '' : ' track--locked'}`,
    tabindex: bookable ? '0' : null,
    'aria-label': bookable
      ? `${room.code}, ${room.capacity} seats. Arrow keys choose a time, Enter books it.`
      : `${room.code}${room.canBook ? '' : ', staff only'}`,
  });
  track.room = room;
  track.busy = busy;
  track.cursor = null;

  if (bookableFrom > 0) {
    const until = Math.min(bookableFrom, slotCount());
    track.append(h('div', { class: 'track__past', style: `width:${(until / slotCount()) * 100}%` }));
  }
  for (const bk of bookings) track.append(block(bk));
  track.append(h('div', { class: 'ghost', hidden: true }, h('span', { class: 'ghost__label mono' })));

  return h('div', { class: 'board__row' },
    h('div', { class: 'board__room' },
      h('a', { class: 'board__code mono', href: `#/room/${room.id}?date=${b.date}`, title: `See ${room.code}'s week` }, room.code),
      h('span', { class: 'board__cap mono' }, `· ${room.capacity}`),
      h('span', { class: 'board__name' }, room.canBook ? room.name : h('em', {}, 'Staff only'))),
    track);
}

function hoursHeader() {
  const labels = [];
  for (let m = open(); m < close(); m += 60) {
    labels.push(h('span', { class: 'board__hour mono', style: `left:${pct(fromMin(m))}%` }, fromMin(m).slice(0, 2)));
  }
  return h('div', { class: 'board__head' },
    h('div', { class: 'board__corner mono' }, 'Room · seats'),
    h('div', { class: 'board__hours' }, ...labels, h('span', { class: 'now-label mono', hidden: true })));
}

function render() {
  const { rooms, bookings } = b.data;
  const bookableFrom = firstBookableSlot();
  const byRoom = new Map(rooms.map((r) => [r.id, []]));
  for (const bk of bookings) byRoom.get(bk.room_id)?.push(bk);

  const groups = [];
  let current = null;
  for (const r of rooms) {
    if (!current || current.code !== r.building_code) {
      current = { code: r.building_code, name: r.building_name, rows: [] };
      groups.push(current);
    }
    current.rows.push(row(r, byRoom.get(r.id), bookableFrom));
  }

  const body = h('div', { class: 'board__body' },
    ...groups.flatMap((g) => [
      groups.length > 1 ? h('div', { class: 'board__group mono' }, `${g.code} · ${g.name}`) : null,
      ...g.rows,
    ]),
    h('div', { class: 'now-line', hidden: true }));

  const inner = h('div', { class: 'board__inner', style: `--slots:${slotCount()}` }, hoursHeader(), body);
  boardEl.replaceChildren(inner);

  const heading = new Date(`${b.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  $('[data-board-heading]', view).textContent = heading;
  const mine = bookings.filter((x) => x.mine).length;
  $('[data-board-summary]', view).textContent =
    `${rooms.length} rooms · ${bookings.length} booking${bookings.length === 1 ? '' : 's'}${mine ? ` · ${mine} yours` : ''}`;
  $('[data-board-date]', view).value = b.date;
  $('[data-board-hint]', view).hidden = bookableFrom >= slotCount();
  placeNowLine();
  // Only when a day is first shown, so the minute-by-minute refresh never jumps the view.
  if (b.scrolledFor !== b.date) {
    b.scrolledFor = b.date;
    scrollToNow();
  }
}

/** The current-time line: a 2px Bone line with the time in mono at the top. Today only. */
function placeNowLine() {
  const line = $('.now-line', boardEl);
  const label = $('.now-label', boardEl);
  if (!line) return;
  const now = new Date();
  const t = hhmm(now);
  const show = b.date === isoDate(now) && toMin(t) >= open() && toMin(t) < close();
  line.hidden = !show;
  label.hidden = !show;
  if (!show) return;
  const p = pct(t);
  line.style.setProperty('--p', p);
  label.style.left = `${p}%`;
  label.textContent = t;
  // Hide an hour mark the time label would sit on top of.
  for (const hr of $$('.board__hour', boardEl)) {
    const mins = Number(hr.textContent) * 60;
    hr.classList.toggle('is-covered', Math.abs(mins - toMin(t)) < 30);
  }
}

/** Opening today's board on a narrow screen: scroll so the current time is in view. */
function scrollToNow() {
  const now = new Date();
  if (b.date !== isoDate(now) || boardEl.scrollWidth <= boardEl.clientWidth) return;
  const label = parseFloat(getComputedStyle(boardEl).getPropertyValue('--label')) || 0;
  const span = boardEl.scrollWidth - label;
  const x = label + (span * Math.max(0, pct(hhmm(now)))) / 100;
  boardEl.scrollLeft = Math.max(0, x - label - (boardEl.clientWidth - label) * 0.25);
}

/* ---------- Choosing a slot ----------------------------------------------------------- */

const canUse = (track, i) => i >= firstBookableSlot() && i < slotCount() && !track.busy[i];

function showGhost(track, from, to) {
  const ghost = $('.ghost', track);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  ghost.hidden = false;
  ghost.style.left = `${(lo / slotCount()) * 100}%`;
  ghost.style.width = `${((hi - lo + 1) / slotCount()) * 100}%`;
  $('.ghost__label', ghost).textContent = `+ ${slotStart(lo)}–${slotStart(hi + 1)}`;
}

function hideGhost(track) {
  $('.ghost', track).hidden = true;
}

function slotAt(track, clientX) {
  const r = track.getBoundingClientRect();
  return Math.floor(((clientX - r.left) / r.width) * slotCount());
}

function book(track, lo, hi) {
  hideGhost(track);
  const room = track.room;
  openSheet(room, {
    date: b.date,
    start: slotStart(lo),
    end: slotStart(hi + 1),
    attendees: Math.min(room.capacity, 10),
  }, { user: b.ctx.user, rules: b.ctx.rules, onBooked: () => load() });
}

/** How far a drag that started at slot i may stretch: contiguous free slots, at most maxHours. */
function dragBounds(track, i) {
  const maxSlots = (b.ctx.rules.maxHours * 60) / step();
  let lo = i;
  let hi = i;
  while (lo - 1 >= 0 && canUse(track, lo - 1) && i - (lo - 1) < maxSlots) lo -= 1;
  while (hi + 1 < slotCount() && canUse(track, hi + 1) && hi + 1 - i < maxSlots) hi += 1;
  return { lo, hi };
}

function onPointerMove(e) {
  const track = e.target.closest?.('.track');
  if (b.drag) {
    const d = b.drag;
    const i = Math.max(d.lo, Math.min(d.hi, slotAt(d.track, e.clientX)));
    d.to = i;
    showGhost(d.track, d.from, d.to);
    return;
  }
  if (!track || !track.room.canBook || e.pointerType === 'touch') return;
  if (e.target.closest('.block')) { hideGhost(track); return; }
  const i = slotAt(track, e.clientX);
  if (canUse(track, i)) showGhost(track, i, i);
  else hideGhost(track);
}

function onPointerDown(e) {
  const track = e.target.closest('.track');
  if (!track || !track.room.canBook || e.button > 0 || e.target.closest('.block')) return;
  const i = slotAt(track, e.clientX);
  if (!canUse(track, i)) return;
  // Touch: a tap books one slot (the sheet can lengthen it); dragging would fight scrolling.
  b.drag = { track, from: i, to: i, ...(e.pointerType === 'touch' ? { lo: i, hi: i } : dragBounds(track, i)) };
  if (e.pointerType !== 'touch') track.setPointerCapture(e.pointerId);
  showGhost(track, i, i);
}

function onPointerUp() {
  if (!b.drag) return;
  const { track, from, to } = b.drag;
  b.drag = null;
  book(track, Math.min(from, to), Math.max(from, to));
}

function onPointerCancel() {
  if (b.drag) hideGhost(b.drag.track);
  b.drag = null;
}

function describeSlot(track, i) {
  const bk = track.busy[i];
  if (i < firstBookableSlot()) return `${slotStart(i)} has passed`;
  if (bk) return `${slotStart(i)} taken: ${bk.course_code || bk.title}, ${bk.start_time}–${bk.end_time}`;
  return `${track.room.code} ${slotStart(i)}–${slotStart(i + 1)} free. Enter to book.`;
}

function onKeyDown(e) {
  const track = e.target.closest?.('.track');
  if (!track || track.classList.contains('track--locked')) return;
  const first = Math.min(firstBookableSlot(), slotCount() - 1);
  if (track.cursor == null) track.cursor = first;
  let i = track.cursor;
  if (e.key === 'ArrowRight') i = Math.min(slotCount() - 1, i + 1);
  else if (e.key === 'ArrowLeft') i = Math.max(first, i - 1);
  else if (e.key === 'Home') i = first;
  else if (e.key === 'End') i = slotCount() - 1;
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (canUse(track, i)) book(track, i, i);
    else live.textContent = describeSlot(track, i);
    return;
  } else return;
  e.preventDefault();
  track.cursor = i;
  if (canUse(track, i)) showGhost(track, i, i); else hideGhost(track);
  live.textContent = describeSlot(track, i);
}

/* ---------- Loading and controls ------------------------------------------------------ */

async function load() {
  showError(view, '');
  try {
    const q = new URLSearchParams({ date: b.date });
    if (b.buildingId) q.set('buildingId', b.buildingId);
    b.data = await api(`/rooms/schedule/day?${q}`);
    render();
  } catch (err) {
    showError(view, err.message);
  }
}

function setDate(date) {
  b.date = date;
  load();
}

function fillBuildings(buildings) {
  const select = $('[data-board-building]', view);
  select.replaceChildren(
    h('option', { value: '' }, 'All buildings'),
    ...buildings.map((x) => h('option', { value: String(x.id) }, `${x.code} · ${x.name}`)),
  );
  if (!buildings.some((x) => String(x.id) === b.buildingId)) b.buildingId = '';
  select.value = b.buildingId;
}

/** Shows the board. ctx: { user, rules, buildings }. */
export function showBoard(ctx) {
  b.ctx = ctx;
  b.date ??= isoDate(new Date());
  b.buildingId = loadSaved();
  fillBuildings(ctx.buildings);
  load();
  hideBoardTimers();
  b.timers.push(setInterval(placeNowLine, 30_000), setInterval(() => { if (!b.drag && !$('[data-sheet]').open) load(); }, 60_000));
}

function hideBoardTimers() {
  for (const t of b.timers) clearInterval(t);
  b.timers = [];
}

export function hideBoard() {
  hideBoardTimers();
}

boardEl.addEventListener('pointermove', onPointerMove);
boardEl.addEventListener('pointerdown', onPointerDown);
boardEl.addEventListener('pointerup', onPointerUp);
boardEl.addEventListener('pointercancel', onPointerCancel);
boardEl.addEventListener('pointerleave', (e) => { if (!b.drag) $$('.ghost', boardEl).forEach((g) => { g.hidden = true; }); });
boardEl.addEventListener('keydown', onKeyDown);
boardEl.addEventListener('focusout', (e) => {
  const track = e.target.closest?.('.track');
  if (track) { hideGhost(track); track.cursor = null; }
});

for (const btn of $$('[data-day-step]', view)) {
  btn.addEventListener('click', () => setDate(addDays(b.date, Number(btn.dataset.dayStep))));
}
$('[data-day-today]', view).addEventListener('click', () => setDate(isoDate(new Date())));
$('[data-board-date]', view).addEventListener('change', (e) => { if (e.target.value) setDate(e.target.value); });
$('[data-board-building]', view).addEventListener('change', (e) => {
  b.buildingId = e.target.value;
  save(b.buildingId);
  load();
});
