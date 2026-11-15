// Statistics for the timetable office. One hue only (Bone at different strengths): the busiest
// hour is the one full-strength bar. Every chart has a hover/focus tooltip and a table view,
// so no value depends on colour or on hovering.
import { api } from './api.js';
import { $, h, isoDate, addDays, longDate, toMin, showError } from './util.js';

const view = $('[data-view="stats"]');
const root = $('[data-stats]', view);
const tip = $('[data-chart-tip]', view);

const CATEGORY = { lecture: 'Lectures', tutorial: 'Tutorials', lab: 'Practicals and labs', exam: 'Exams', meeting: 'Meetings', study: 'Study', event: 'Events' };
const st = { range: '30', from: '', to: '', buildingId: '', data: null, tables: new Set(), seq: 0 };

/* ---------- Formatting ------------------------------------------------------------------ */

const pct = (x, digits = 1) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? digits : 0)}%`;
const hrs = (n) => (n === 0 ? '0 h' : n < 10 ? `${n.toFixed(1).replace(/\.0$/, '')} h` : `${Math.round(n).toLocaleString('en-GB')} h`);
const num = (n) => n.toLocaleString('en-GB');
const hh = (hour) => `${String(hour).padStart(2, '0')}:00`;

function rangeDates() {
  const today = isoDate(new Date());
  if (st.range === 'custom') return { from: st.from || addDays(today, -29), to: st.to || today };
  if (st.range === 'next30') return { from: today, to: addDays(today, 29) };
  const days = Number(st.range);
  return { from: addDays(today, -(days - 1)), to: today };
}

/** "▲ 12% vs previous 30 days": direction by glyph and words, never by colour. */
function delta(cur, prev, { points = false } = {}) {
  const span = st.data.range.days;
  const vs = `vs previous ${span} day${span === 1 ? '' : 's'}`;
  if (points) {
    const d = (cur - prev) * 100;
    if (Math.abs(d) < 0.05) return `No change ${vs}`;
    return `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} pts ${vs}`;
  }
  if (!prev) return cur ? `New this period · none ${vs}` : `None this period or the one before`;
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.005) return `No change ${vs}`;
  return `${d > 0 ? '▲' : '▼'} ${Math.round(Math.abs(d) * 100)}% ${vs}`;
}

/* ---------- Tooltip --------------------------------------------------------------------- */

function showTip(target, lines, event) {
  tip.replaceChildren(h('strong', {}, lines[0]), ...lines.slice(1).map((l) => h('span', {}, l)));
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const x = event?.clientX ?? r.left + r.width / 2;
  const y = event?.clientY ?? r.top;
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
  tip.style.top = `${Math.max(8, y - tip.offsetHeight - 12)}px`;
}
const hideTip = () => { tip.hidden = true; };

/** Makes a mark focusable and gives it the same tooltip on hover and on keyboard focus. */
function withTip(el, lines) {
  el.tabIndex = 0;
  el.setAttribute('aria-label', lines.join(', '));
  el.addEventListener('pointermove', (e) => showTip(el, lines, e));
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('focus', () => showTip(el, lines));
  el.addEventListener('blur', hideTip);
  return el;
}

/* ---------- Cards ------------------------------------------------------------------------ */

function card(key, title, subtitle, chart, table, extra = null) {
  const showTable = st.tables.has(key);
  const toggle = h('button', { class: 'link-button card__toggle', type: 'button', 'aria-pressed': String(showTable) },
    showTable ? 'Show chart' : 'Show table');
  toggle.addEventListener('click', () => {
    if (st.tables.has(key)) st.tables.delete(key); else st.tables.add(key);
    render();
    $(`[data-card="${key}"] .card__toggle`, root)?.focus();
  });
  return h('section', { class: `panel stat-card stat-card--${key}`, 'data-card': key, 'aria-labelledby': `card-${key}` },
    h('header', { class: 'stat-card__head' },
      h('div', {},
        h('h2', { class: 'stat-card__title', id: `card-${key}` }, title),
        h('p', { class: 'stat-card__sub' }, subtitle)),
      h('div', { class: 'stat-card__tools' }, extra, toggle)),
    showTable ? table() : chart());
}

function table(caption, headers, rows) {
  return h('div', { class: 'stat-table' },
    h('table', {},
      h('caption', { class: 'visually-hidden' }, caption),
      h('thead', {}, h('tr', {}, headers.map((t, i) => h('th', { scope: 'col', class: i ? 'num' : null }, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => (i ? h('td', { class: 'num mono' }, c) : h('th', { scope: 'row' }, c))))))));
}

/* KPI row: one hero figure (utilisation), then supporting tiles. */
function kpis(d) {
  const c = d.current;
  const p = d.previous;
  const req = d.requests;
  const decided = req.approved + req.rejected;
  const available = c.rooms * c.teachingDays * ((toMin(d.range.close) - toMin(d.range.open)) / 60);
  const tile = (label, value, note, cls = '') => h('div', { class: `kpi ${cls}` },
    h('p', { class: 'kpi__label' }, label), h('p', { class: 'kpi__value serif' }, value), h('p', { class: 'kpi__note' }, note));
  return h('section', { class: 'kpis', 'aria-label': 'Headline figures' },
    tile('Room utilisation', pct(c.utilisation), `${hrs(c.hours)} of ${hrs(available)} available · ${delta(c.utilisation, p.utilisation, { points: true })}`, 'kpi--hero'),
    tile('Bookings', num(c.bookings), `${delta(c.bookings, p.bookings)}${c.cancelled ? ` · ${num(c.cancelled)} cancelled` : ''}`),
    tile('Hours booked', hrs(c.hours), delta(c.hours, p.hours)),
    tile('Student requests', num(req.total), req.total
      ? `${num(req.approved)} approved · ${num(req.rejected)} rejected · ${num(req.pending)} waiting`
      : 'None in this period'),
    tile('Time to a decision', req.medianDecisionHours == null ? '—' : hrs(req.medianDecisionHours),
      decided ? `Median, from request to decision · ${decided} decided` : 'No decisions in this period'));
}

/* Busiest hours: columns, the busiest at full strength (emphasis form), value on its cap only. */
function hoursChart(d) {
  const data = d.hours;
  const max = Math.max(...data.map((x) => x.hours));
  if (!max) return h('p', { class: 'stat-empty' }, 'No bookings in this range.');
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const busiest = data.reduce((a, b) => (b.hours > a.hours ? b : a));
  return h('div', { class: 'colchart', role: 'group', 'aria-label': 'Room-hours booked in each hour of the day' },
    h('div', { class: 'colchart__plot' },
      ...ticks.map((v) => h('div', { class: 'colchart__grid', style: `bottom:${(v / top) * 100}%` },
        h('span', { class: 'colchart__tick mono' }, hrs(v)))),
      h('div', { class: 'colchart__cols' }, data.map((x) => {
        const isTop = x === busiest;
        const col = h('div', { class: `colchart__col${isTop ? ' is-top' : ''}` },
          isTop ? h('span', { class: 'colchart__cap mono', style: `bottom:${(x.hours / top) * 100}%` }, hrs(x.hours)) : null,
          h('span', { class: 'colchart__bar', style: `height:${(x.hours / top) * 100}%` }));
        return withTip(col, [hrs(x.hours), `${hh(x.hour)}–${hh(x.hour + 1)}${isTop ? ' · busiest' : ''}`]);
      }))),
    h('div', { class: 'colchart__axis mono', 'aria-hidden': 'true' }, data.map((x) => h('span', {}, String(x.hour).padStart(2, '0')))));
}

function niceStep(max) {
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || pow * 10;
}

/* Rooms: a meter list, each room against 100% of its own available time. */
function roomsChart(d) {
  if (!d.rooms.length) return h('p', { class: 'stat-empty' }, 'No rooms in this building.');
  return h('ol', { class: 'meters' }, d.rooms.map((r) => {
    const meter = h('span', { class: 'meter' }, h('span', { class: 'meter__fill', style: `width:${Math.min(100, r.utilisation * 100)}%` }));
    const row = h('li', { class: `meters__row${r.minutes ? '' : ' is-idle'}` },
      h('span', { class: 'meters__code mono' }, r.code),
      h('span', { class: 'meters__name' }, r.name),
      meter,
      h('span', { class: 'meters__fig mono' }, pct(r.utilisation)),
      h('span', { class: 'meters__sub mono' }, r.minutes ? `${hrs(r.hours)} · ${r.bookings} booking${r.bookings === 1 ? '' : 's'}` : 'not used'));
    return withTip(row, [pct(r.utilisation), `${r.code} · ${r.name}`, `${hrs(r.hours)} booked, ${r.bookings} booking${r.bookings === 1 ? '' : 's'}`,
      r.minutes ? `On average ${Math.round(r.avg_fill * 100)}% of its ${r.capacity} seats used` : `${r.capacity} seats`]);
  }));
}

function roomsNote(d) {
  const idle = d.rooms.filter((r) => r.utilisation < 0.1);
  const roomy = d.rooms.filter((r) => r.minutes && r.avg_fill < 0.35);
  const notes = [];
  if (idle.length) notes.push(`${idle.length} of ${d.rooms.length} rooms were booked less than 10% of the time.`);
  if (roomy.length) notes.push(`${roomy.map((r) => r.code).slice(0, 4).join(', ')}${roomy.length > 4 ? ' and others' : ''} were on average under a third full: smaller rooms would do.`);
  return notes.length ? h('p', { class: 'stat-note' }, notes.join(' ')) : null;
}

/* What rooms are booked for: ranked bars, one hue, value at the tip. */
function categoriesChart(d) {
  if (!d.categories.length) return h('p', { class: 'stat-empty' }, 'No bookings in this range.');
  const max = Math.max(...d.categories.map((c) => c.hours));
  return h('ol', { class: 'hbars' }, d.categories.map((c) => {
    const row = h('li', { class: 'hbars__row' },
      h('span', { class: 'hbars__label' }, CATEGORY[c.category] || c.category),
      h('span', { class: 'hbars__track' },
        h('span', { class: 'hbars__bar', style: `width:${(c.hours / max) * 100}%` }),
        h('span', { class: 'hbars__val mono' }, hrs(c.hours))));
    return withTip(row, [hrs(c.hours), CATEGORY[c.category] || c.category, `${c.bookings} booking${c.bookings === 1 ? '' : 's'}`]);
  }));
}

function downloadCsv(d) {
  const rows = [['Room', 'Name', 'Building', 'Seats', 'Bookings', 'Hours booked', 'Utilisation %', 'Average seats used %']]
    .concat(d.rooms.map((r) => [r.code, r.name, r.building_code, r.capacity, r.bookings, r.hours,
      (r.utilisation * 100).toFixed(1), Math.round(r.avg_fill * 100)]));
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: `room-utilisation_${d.range.from}_to_${d.range.to}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Page ---------------------------------------------------------------------- */

function render() {
  const d = st.data;
  if (!d) return;
  const r = d.range;
  $('[data-stats-summary]', view).textContent =
    `${longDate(r.from)} – ${longDate(r.to)} · ${r.days} day${r.days === 1 ? '' : 's'}, ${r.teachingDays} teaching · `
    + `${d.current.rooms} rooms · ${r.open}–${r.close}`;
  const csv = h('button', { class: 'link-button', type: 'button', onclick: () => downloadCsv(d) }, 'Download CSV');
  root.replaceChildren(
    kpis(d),
    h('div', { class: 'stat-grid' },
      card('hours', 'Busiest hours', 'Room-hours booked in each hour of the day, all rooms together',
        () => hoursChart(d),
        () => table('Room-hours booked by hour', ['Hour', 'Room-hours'], d.hours.map((x) => [`${hh(x.hour)}–${hh(x.hour + 1)}`, hrs(x.hours)]))),
      card('categories', 'What rooms are booked for', 'Hours booked by purpose',
        () => categoriesChart(d),
        () => table('Hours booked by purpose', ['Purpose', 'Bookings', 'Hours'], d.categories.map((c) => [CATEGORY[c.category] || c.category, num(c.bookings), hrs(c.hours)]))),
      card('rooms', 'Room utilisation', `Share of each room’s time booked, ${r.open}–${r.close} on teaching days. Busiest first`,
        () => h('div', {}, roomsNote(d), roomsChart(d)),
        () => table('Room utilisation', ['Room', 'Seats', 'Bookings', 'Hours', 'Utilisation', 'Avg seats used'],
          d.rooms.map((x) => [`${x.code} · ${x.name}`, num(x.capacity), num(x.bookings), hrs(x.hours), pct(x.utilisation), x.minutes ? `${Math.round(x.avg_fill * 100)}%` : '—'])),
        csv)));
}

async function load() {
  const seq = ++st.seq;
  showError(view, '');
  // Refetch keeps the frame: the old figures stay, dimmed, until the new ones arrive.
  root.classList.add('is-loading');
  root.setAttribute('aria-busy', 'true');
  try {
    const { from, to } = rangeDates();
    const q = new URLSearchParams({ from, to });
    if (st.buildingId) q.set('buildingId', st.buildingId);
    const data = await api(`/admin/stats?${q}`);
    if (seq !== st.seq) return; // a newer filter change won
    st.data = data;
    render();
  } catch (err) {
    showError(view, err.message);
  } finally {
    if (seq === st.seq) {
      root.classList.remove('is-loading');
      root.removeAttribute('aria-busy');
    }
  }
}

/** Shows the page. buildings: for the building filter. */
export function showStats({ buildings }) {
  const sel = $('[data-stats-building]', view);
  sel.replaceChildren(h('option', { value: '' }, 'All buildings'),
    ...buildings.map((b) => h('option', { value: String(b.id) }, `${b.code} · ${b.name}`)));
  sel.value = st.buildingId;
  load();
}

$('[data-stats-range]', view).addEventListener('change', (e) => {
  st.range = e.target.value;
  const custom = st.range === 'custom';
  $('[data-stats-custom]', view).hidden = !custom;
  if (custom) {
    const { from, to } = rangeDates();
    $('[data-stats-from]', view).value = st.from || from;
    $('[data-stats-to]', view).value = st.to || to;
    $('[data-stats-from]', view).focus();
  }
  load();
});
for (const key of ['from', 'to']) {
  $(`[data-stats-${key}]`, view).addEventListener('change', (e) => { st[key] = e.target.value; load(); });
}
$('[data-stats-building]', view).addEventListener('change', (e) => { st.buildingId = e.target.value; load(); });
window.addEventListener('scroll', hideTip, { passive: true });
