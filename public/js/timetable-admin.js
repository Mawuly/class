// /admin → Timetable: import a programme's weekly timetable for a semester, see what is imported,
// and take a timetable off again.
import { api } from './api.js';
import { $, h, showError, longDate } from './util.js';

const view = $('[data-view="timetable"]');
const form = $('[data-form="timetable"]', view);
const previewBox = $('[data-timetable-preview]', view);
const listBox = $('[data-timetable-list]', view);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EXAMPLE = `Day,Start,End,Code,Title,Room,Lecturer
Monday,9:30 AM,11:30 AM,ADM301,International Business,NLT 10,Dr. Mark Bigool
Thursday,12:30 PM,2:30 PM,SBU301,Operations Management,SWLT 18,Priscilla Oppong`;

let previewed = null; // the body that was previewed, so Import books exactly that

const body = () => ({
  label: form.label.value.trim(), from: form.from.value, to: form.to.value, table: form.table.value,
});

function previewTable(p) {
  const ok = p.rows.filter((r) => !r.problem && r.weeks);
  const lectures = ok.reduce((n, r) => n + r.weeks, 0);
  const rows = p.rows.map((r) => h('tr', { class: r.problem ? 'tt-row--problem' : '' },
    h('td', {}, r.day), h('td', { class: 'mono' }, r.start && r.end ? `${r.start}–${r.end}` : '—'),
    h('td', { class: 'mono' }, r.code || ''), h('td', {}, r.title || ''), h('td', { class: 'mono' }, r.room || '—'),
    h('td', {}, r.lecturer || ''), h('td', { class: 'mono num' }, r.problem ? '—' : String(r.weeks)),
    h('td', { class: 'tt-note' }, r.problem
      ? `⚠ ${r.problem}`
      : r.skipped.length ? `Skips ${r.skipped.map((s) => `${longDate(s.date)} (${s.reason})`).join('; ')}` : '')));
  return h('div', { class: 'tt-preview' },
    h('p', { class: 'tt-summary' }, `${ok.length} of ${p.rows.length} classes can be booked: ${lectures} lectures, `
      + `${longDate(p.from)} – ${longDate(p.to)}.`
      + (p.rows.length > ok.length ? ' Classes marked ⚠ are left out; fix them and preview again, or import the rest.' : '')),
    h('div', { class: 'stat-table' }, h('table', {},
      h('thead', {}, h('tr', {}, ...['Day', 'Time', 'Code', 'Course', 'Room', 'Lecturer', 'Weeks', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows))),
    lectures
      ? h('div', { class: 'sheet__actions' },
        h('button', { class: 'button button--primary', type: 'button', onclick: doImport }, `Import ${lectures} lectures`))
      : '');
}

async function doPreview() {
  showError(view, '');
  const b = body();
  try {
    const p = await api('/admin/timetables/preview', { method: 'POST', body: b });
    previewed = b;
    previewBox.replaceChildren(previewTable(p));
  } catch (err) {
    previewed = null;
    previewBox.replaceChildren();
    showError(view, err.message);
  }
}

async function doImport(e) {
  if (!previewed) return;
  e.target.disabled = true;
  showError(view, '');
  try {
    const res = await api('/admin/timetables', { method: 'POST', body: previewed });
    previewBox.replaceChildren(h('p', { class: 'auth__done', role: 'status' },
      `Imported "${res.label}": ${res.classes} classes, ${res.lectures} lectures. They show as booked; `
      + 'a class nobody checks in to is released and shows as free.'));
    previewed = null;
    await loadList();
  } catch (err) {
    e.target.disabled = false;
    showError(view, err.message);
  }
}

async function loadList() {
  const { classes } = await api('/admin/timetables');
  if (!classes.length) {
    listBox.replaceChildren(h('p', { class: 'muted' }, 'No timetable imported yet.'));
    return;
  }
  const groups = new Map();
  for (const c of classes) groups.set(c.label, [...(groups.get(c.label) || []), c]);
  listBox.replaceChildren(...[...groups].map(([label, list]) => {
    let armed = null;
    const remove = h('button', { class: 'link-button', type: 'button' }, 'Remove remaining lectures');
    remove.addEventListener('click', async () => {
      if (!armed) {
        remove.textContent = 'Click again to cancel every lecture still to come';
        armed = setTimeout(() => { armed = null; remove.textContent = 'Remove remaining lectures'; }, 5000);
        return;
      }
      clearTimeout(armed);
      remove.disabled = true;
      try {
        await api('/admin/timetables/remove', { method: 'POST', body: { label } });
        await loadList();
      } catch (err) {
        remove.disabled = false;
        remove.textContent = err.message;
      }
    });
    const upcoming = list.reduce((n, c) => n + c.upcoming, 0);
    const checked = list.reduce((n, c) => n + c.checked_in, 0);
    const released = list.reduce((n, c) => n + c.released, 0);
    return h('section', { class: 'tt-group panel' },
      h('div', { class: 'tt-group__head' },
        h('div', {}, h('h3', { class: 'panel__title' }, label),
          h('p', { class: 'muted' }, `${list.length} weekly classes · ${upcoming} lectures to come · ${checked} checked in · ${released} released (no-show)`)),
        upcoming ? remove : ''),
      h('ul', { class: 'tt-classes' }, list.map((c) => h('li', {},
        h('span', { class: 'mono' }, `${DAYS[c.weekday].slice(0, 3)} ${c.start_time}–${c.end_time}`),
        h('span', { class: 'mono' }, c.room_code),
        h('span', {}, [c.course_code, c.title].filter(Boolean).join(' · '), c.lecturer ? h('small', {}, ` · ${c.lecturer}`) : ''),
        h('span', { class: 'mono muted' }, `${longDate(c.first_date)} – ${longDate(c.last_date)}`)))));
  }));
}

form.addEventListener('submit', (e) => { e.preventDefault(); doPreview(); });
form.addEventListener('input', () => { previewed = null; });
$('[data-timetable-example]', view).addEventListener('click', () => { form.table.value = EXAMPLE; form.table.focus(); });
$('[data-timetable-file]', view).addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) form.table.value = await file.text();
});

export function showTimetable() {
  showError(view, '');
  loadList().catch((err) => showError(view, err.message));
}
