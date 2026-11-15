// Room week view: one room, Monday to Sunday across, time running down like a printed timetable.
// Click an empty slot to book it, or drag down for longer. Keyboard: Tab to a day, ↑/↓ choose a
// time, ←/→ change day, Enter books.
import { api } from './api.js';
import { openSheet } from './sheet.js';
import { $, $$, h, toMin, fromMin, isoDate, hhmm, addDays, showError } from './util.js';

const view = $('[data-view="week"]');
const grid = $('[data-week]', view);
const live = $('[data-week-live]', view);

const TYPE_LABEL = { lecture_hall: 'Lecture hall', lab: 'Lab', seminar: 'Seminar room', study: 'Study room', meeting: 'Meeting room' };
const FACILITY = { projector: 'Projector', whiteboard: 'Whiteboard', pa_system: 'PA system', ac: 'Air conditioning', computers: 'Computers', video_conf: 'Video conferencing' };
const facility = (k) => FACILITY[k] || k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const w = { ctx: null, roomId: null, date: null, data: null, drag: null, timers: [], scrolledFor: null };

/* ---------- Geometry ---------------------------------------------------------------- */

const open = () => toMin(w.data.open);
const close = () => toMin(w.data.close);
const step = () => w.ctx.rules.slotMinutes;
const slots = () => (close() - open()) / step();
const pctOf = (t) => ((toMin(t) - open()) / (close() - open())) * 100;
const slotStart = (i) => fromMin(open() + i * step());
const dayList = () => Array.from({ length: 7 }, (_, i) => addDays(w.data.from, i));

/** First slot still bookable on a day: none for past days, from "now" today, all for future days. */
function firstBookable(date) {
  const today = isoDate(new Date());
  if (date < today) return Infinity;
  if (date > today) return 0;
  const now = new Date();
  return Math.max(0, Math.ceil((now.getHours() * 60 + now.getMinutes() - open()) / step()));
}

/* ---------- Rendering ---------------------------------------------------------------- */

function block(b) {
  const label = `${b.course_code ? `${b.course_code} · ` : ''}${b.title}`;
  return h('div', {
    class: `wblock block--${b.status}${b.mine ? ' block--mine' : ''}`,
    style: `top:${pctOf(b.start_time)}%;height:${pctOf(b.end_time) - pctOf(b.start_time)}%`,
    title: `${label}\n${b.start_time}–${b.end_time} · ${b.status === 'pending' ? 'awaiting approval' : 'booked'}${b.mine ? ' · yours' : ''}`,
  },
  h('span', { class: 'wblock__time mono' }, `${b.start_time}–${b.end_time}`),
  h('span', { class: 'wblock__title' }, b.mine ? h('span', { 'aria-hidden': 'true' }, '■ ') : '', label));
}

function dayColumn(date, bookings) {
  const busy = new Array(slots()).fill(null);
  for (const b of bookings) {
    const s = Math.max(0, Math.floor((toMin(b.start_time) - open()) / step()));
    const e = Math.min(slots(), Math.ceil((toMin(b.end_time) - open()) / step()));
    for (let i = s; i < e; i++) busy[i] = b;
  }
  const from = firstBookable(date);
  const bookable = w.data.room.canBook && from < slots();
  const long = new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const col = h('div', {
    class: `wday${date === isoDate(new Date()) ? ' is-today' : ''}${w.data.room.canBook ? '' : ' wday--locked'}`,
    tabindex: bookable ? '0' : null,
    'aria-label': bookable ? `${long}. Up and down arrows choose a time, Enter books it.` : long,
  });
  Object.assign(col, { date, busy, cursor: null });
  if (from > 0) {
    col.append(h('div', { class: 'wday__past', style: `height:${(Math.min(from, slots()) / slots()) * 100}%` }));
  }
  for (const b of bookings) col.append(block(b));
  col.append(h('div', { class: 'wghost', hidden: true }, h('span', { class: 'wghost__label mono' })));
  return col;
}

function render() {
  const d = w.data;
  const r = d.room;
  const days = dayList();
  const today = isoDate(new Date());
  const byDay = new Map(days.map((x) => [x, []]));
  for (const b of d.bookings) byDay.get(b.date)?.push(b);

  $('[data-week-code]', view).textContent = r.code;
  $('[data-week-name]', view).textContent = `${r.name} · ${r.building_name}`;
  $('[data-week-facts]', view).textContent = [`${r.capacity} seats`, TYPE_LABEL[r.type] || r.type, `floor ${r.floor}`,
    r.bookable_by === 'staff' ? 'staff only' : 'everyone can book', ...r.facilities.map(facility)].join(' · ');
  const fmt = (x, opts) => new Date(`${x}T00:00:00`).toLocaleDateString('en-GB', opts);
  $('[data-week-range]', view).textContent = `${fmt(d.from, { day: 'numeric', month: 'short' })} – ${fmt(d.to, { day: 'numeric', month: 'short', year: 'numeric' })}`
    + ` · ${d.bookings.length} booking${d.bookings.length === 1 ? '' : 's'}`;
  $('[data-week-date]', view).value = w.date;
  const isThisWeek = d.from <= today && today <= d.to;
  $('[data-week-today]', view).disabled = isThisWeek;

  const hours = [];
  for (let m = open(); m < close(); m += 60) hours.push(h('span', { class: 'wtime__h mono', style: `top:${pctOf(fromMin(m))}%` }, fromMin(m)));

  grid.replaceChildren(h('div', { class: 'week__inner', style: `--slots:${slots()}` },
    h('div', { class: 'week__corner' }),
    ...days.map((x) => h('div', { class: `week__day${x === today ? ' is-today' : ''}${x < today ? ' is-past' : ''}` },
      h('span', { class: 'week__dow' }, fmt(x, { weekday: 'short' })),
      h('span', { class: 'week__date mono' }, fmt(x, { day: 'numeric' })))),
    h('div', { class: 'wtime', 'aria-hidden': 'true' }, ...hours),
    // Placed explicitly, so the current-time line can share today's cell without displacing it.
    ...days.map((x, i) => {
      const col = dayColumn(x, byDay.get(x));
      col.style.gridArea = `2 / ${i + 2}`;
      return col;
    }),
    h('div', { class: 'wnow', hidden: true }, h('span', { class: 'wnow__label mono' }))));

  const hint = $('[data-week-hint]', view);
  hint.textContent = r.canBook
    ? 'Click an empty slot to book it, or drag down for longer. Keyboard: Tab to a day, ↑ ↓ choose a time, ← → change day, Enter books.'
    : 'Only staff can book this room. Its timetable is shown so you can see when it is in use.';
  placeNow();
  if (w.scrolledFor !== d.from) {
    w.scrolledFor = d.from;
    scrollToToday();
  }
}

/** The current-time line across today's column. */
function placeNow() {
  const line = $('.wnow', grid);
  if (!line) return;
  const now = new Date();
  const t = hhmm(now);
  const col = $$('.wday', grid).find((c) => c.date === isoDate(now));
  const show = Boolean(col) && toMin(t) >= open() && toMin(t) < close();
  line.hidden = !show;
  if (!show) return;
  line.style.gridColumn = String(dayList().indexOf(col.date) + 2);
  line.style.setProperty('--p', pctOf(t));
  $('.wnow__label', line).textContent = t;
}

/** On narrow screens the week scrolls sideways: bring today into view. */
function scrollToToday() {
  const col = $('.wday.is-today', grid);
  if (!col || grid.scrollWidth <= grid.clientWidth) return;
  grid.scrollLeft = Math.max(0, col.offsetLeft - 64);
}

/* ---------- Choosing a slot ------------------------------------------------------------ */

const canUse = (col, i) => i >= firstBookable(col.date) && i >= 0 && i < slots() && !col.busy[i];

function slotAt(col, clientY) {
  const r = col.getBoundingClientRect();
  return Math.floor(((clientY - r.top) / r.height) * slots());
}

function showGhost(col, a, b) {
  const ghost = $('.wghost', col);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  ghost.hidden = false;
  ghost.style.top = `${(lo / slots()) * 100}%`;
  ghost.style.height = `${((hi - lo + 1) / slots()) * 100}%`;
  $('.wghost__label', ghost).textContent = `+ ${slotStart(lo)}–${slotStart(hi + 1)}`;
}

const hideGhost = (col) => { $('.wghost', col).hidden = true; };
const hideAllGhosts = () => $$('.wghost', grid).forEach((g) => { g.hidden = true; });

function dragBounds(col, i) {
  const max = (w.ctx.rules.maxHours * 60) / step();
  let lo = i;
  let hi = i;
  while (lo - 1 >= 0 && canUse(col, lo - 1) && i - (lo - 1) < max) lo -= 1;
  while (hi + 1 < slots() && canUse(col, hi + 1) && hi + 1 - i < max) hi += 1;
  return { lo, hi };
}

function book(col, lo, hi) {
  hideGhost(col);
  const room = { ...w.data.room };
  openSheet(room, { date: col.date, start: slotStart(lo), end: slotStart(hi + 1), attendees: Math.min(room.capacity, 10) },
    { user: w.ctx.user, rules: w.ctx.rules, onBooked: () => load() });
}

function onPointerMove(e) {
  if (w.drag) {
    const d = w.drag;
    d.to = Math.max(d.lo, Math.min(d.hi, slotAt(d.col, e.clientY)));
    showGhost(d.col, d.from, d.to);
    return;
  }
  const col = e.target.closest?.('.wday');
  if (!col || !w.data.room.canBook || e.pointerType === 'touch') return;
  hideAllGhosts();
  if (e.target.closest('.wblock')) return;
  const i = slotAt(col, e.clientY);
  if (canUse(col, i)) showGhost(col, i, i);
}

function onPointerDown(e) {
  const col = e.target.closest('.wday');
  if (!col || !w.data.room.canBook || e.button > 0 || e.target.closest('.wblock')) return;
  const i = slotAt(col, e.clientY);
  if (!canUse(col, i)) return;
  // Touch: a tap books one slot (the sheet can lengthen it); dragging would fight scrolling.
  w.drag = { col, from: i, to: i, ...(e.pointerType === 'touch' ? { lo: i, hi: i } : dragBounds(col, i)) };
  if (e.pointerType !== 'touch') col.setPointerCapture(e.pointerId);
  showGhost(col, i, i);
}

function onPointerUp() {
  if (!w.drag) return;
  const { col, from, to } = w.drag;
  w.drag = null;
  book(col, Math.min(from, to), Math.max(from, to));
}

function describe(col, i) {
  const b = col.busy[i];
  const day = new Date(`${col.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long' });
  if (i < firstBookable(col.date)) return `${day} ${slotStart(i)} has passed`;
  if (b) return `${day} ${slotStart(i)} taken: ${b.course_code || b.title}, ${b.start_time}–${b.end_time}`;
  return `${day} ${slotStart(i)}–${slotStart(i + 1)} free. Enter to book.`;
}

function onKeyDown(e) {
  const col = e.target.closest?.('.wday');
  if (!col || !w.data.room.canBook) return;
  const first = Math.min(Math.max(0, firstBookable(col.date)), slots() - 1);
  if (col.cursor == null) col.cursor = first;
  let i = col.cursor;
  if (e.key === 'ArrowDown') i = Math.min(slots() - 1, i + 1);
  else if (e.key === 'ArrowUp') i = Math.max(first, i - 1);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const cols = $$('.wday[tabindex]', grid);
    const next = cols[cols.indexOf(col) + (e.key === 'ArrowLeft' ? -1 : 1)];
    if (next) {
      e.preventDefault();
      next.cursor = Math.max(i, Math.max(0, firstBookable(next.date)));
      next.focus();
      if (canUse(next, next.cursor)) showGhost(next, next.cursor, next.cursor);
      live.textContent = describe(next, next.cursor);
    }
    return;
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (canUse(col, i)) book(col, i, i); else live.textContent = describe(col, i);
    return;
  } else return;
  e.preventDefault();
  col.cursor = i;
  hideAllGhosts();
  if (canUse(col, i)) showGhost(col, i, i);
  live.textContent = describe(col, i);
}

/* ---------- Loading ------------------------------------------------------------------- */

async function load() {
  showError(view, '');
  try {
    w.data = await api(`/rooms/${w.roomId}/week?date=${w.date}`);
    render();
  } catch (err) {
    showError(view, err.message);
    if (err.status === 404) grid.replaceChildren(h('p', { class: 'stat-empty' }, 'This room doesn’t exist or is no longer available.'));
  }
}

function setDate(date) {
  w.date = date;
  // Keep the address in step without adding a history entry for every click.
  history.replaceState(null, '', `#/room/${w.roomId}?date=${date}`);
  load();
}

/** Shows the week for a room. ctx: { user, rules }. */
export function showWeek(ctx, roomId, date) {
  w.ctx = ctx;
  if (w.roomId !== roomId) w.scrolledFor = null;
  w.roomId = roomId;
  w.date = date || isoDate(new Date());
  load();
  hideWeek();
  w.timers.push(setInterval(placeNow, 30_000), setInterval(() => { if (!w.drag && !$('[data-sheet]').open) load(); }, 60_000));
}

export function hideWeek() {
  for (const t of w.timers) clearInterval(t);
  w.timers = [];
}

/** The address of a room's week, for links elsewhere. */
export const weekHref = (roomId, date) => `#/room/${roomId}${date ? `?date=${date}` : ''}`;

grid.addEventListener('pointermove', onPointerMove);
grid.addEventListener('pointerdown', onPointerDown);
grid.addEventListener('pointerup', onPointerUp);
grid.addEventListener('pointercancel', () => { if (w.drag) hideGhost(w.drag.col); w.drag = null; });
grid.addEventListener('pointerleave', () => { if (!w.drag) hideAllGhosts(); });
grid.addEventListener('keydown', onKeyDown);
grid.addEventListener('focusout', (e) => {
  const col = e.target.closest?.('.wday');
  if (col) { hideGhost(col); col.cursor = null; }
});
for (const b of $$('[data-week-step]', view)) {
  b.addEventListener('click', () => setDate(addDays(w.date, 7 * Number(b.dataset.weekStep))));
}
$('[data-week-today]', view).addEventListener('click', () => setDate(isoDate(new Date())));
$('[data-week-date]', view).addEventListener('change', (e) => { if (e.target.value) setDate(e.target.value); });
