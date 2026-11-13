import { api } from './api.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Builds an element. Text is always set with textContent, so nothing from the server is parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

function longDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

const state = { user: null, meta: null };

/* ---------- Clock ------------------------------------------------------------------ */

function tickClock() {
  const now = new Date();
  const day = now.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase();
  const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toUpperCase();
  $('[data-clock]').textContent = `${day} ${date} · ${hhmm(now)}`;
}

/* ---------- Campus footage --------------------------------------------------------- */

function period(hour) {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

function startFootage() {
  const video = $('.stage__video');
  const saveData = navigator.connection?.saveData;
  const small = matchMedia('(max-width: 720px)').matches;
  // Phones and Data Saver users get the still poster only, to save mobile data.
  const p = period(new Date().getHours());
  video.poster = `/media/campus-${p}.jpg`;
  if (saveData || small) return;

  video.replaceChildren(
    h('source', { src: `/media/campus-${p}.webm`, type: 'video/webm' }),
    h('source', { src: `/media/campus-${p}.mp4`, type: 'video/mp4' }),
  );
  video.playbackRate = 0.85; // a touch slower, so the motion reads as calm
  video.addEventListener('playing', () => document.body.classList.add('has-video'), { once: true });
  video.load();
  const sync = () => {
    if (prefersReducedMotion.matches || document.hidden) video.pause();
    else video.play().catch(() => {});
  };
  prefersReducedMotion.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  sync();
}

/* ---------- Live room counter and ticker -------------------------------------------- */

async function refreshNow() {
  let data;
  try {
    data = await api('/public/now');
  } catch {
    return; // keep showing the last numbers
  }
  $('[data-total]').textContent = ` / ${data.total}`;
  if (data.isOpen) {
    $('[data-free]').textContent = data.free;
    $('[data-now-label]').textContent = data.free === 1 ? 'room free right now' : 'rooms free right now';
  } else {
    $('[data-free]').textContent = '0';
    $('[data-now-label]').textContent = `rooms open ${data.time < data.open ? 'today' : 'tomorrow'} at ${data.open}`;
  }

  const items = data.ticker.map((t) => h('span', { class: 'ticker__item' }, h('b', {}, t.code), ` ${t.text}`));
  const track = $('[data-ticker-track]');
  if (!items.length) {
    track.replaceChildren(h('span', { class: 'ticker__item' }, data.isOpen ? 'Every room is in use' : `Bookable ${data.open}–${data.close}`));
    track.classList.remove('is-moving');
    return;
  }
  // Two copies side by side make the loop seamless.
  track.replaceChildren(...items, ...items.map((n) => {
    const copy = n.cloneNode(true);
    copy.setAttribute('aria-hidden', 'true');
    return copy;
  }));
  track.style.setProperty('--ticker-duration', `${Math.max(20, items.length * 5)}s`);
  track.classList.add('is-moving');
}

/* ---------- Sign in / register ------------------------------------------------------ */

function showError(form, message) {
  const el = $('[data-error]', form);
  el.textContent = message || '';
  el.hidden = !message;
}

function switchForm(name) {
  for (const f of $$('.auth form')) f.hidden = f.dataset.form !== name;
  $(`[data-form="${name}"] input`).focus();
}

async function submitAuth(form, path) {
  showError(form, '');
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    const { user } = await api(path, { method: 'POST', body });
    form.reset();
    await enterApp(user);
  } catch (err) {
    showError(form, err.message);
  } finally {
    button.disabled = false;
  }
}

/* ---------- Dashboard ------------------------------------------------------------- */

function greeting(name) {
  const hr = new Date().getHours();
  const part = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name.split(' ').filter((w) => !/\.$/.test(w))[0] || name}`;
}

/** The next bookable 30-minute slot: now (rounded up), or 07:00 on the next open day. */
function nextSlot() {
  const { open, close } = state.meta.rules;
  const now = new Date();
  let mins = Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30;
  let date = now;
  if (mins < toMin(open)) mins = toMin(open);
  if (mins + 60 > toMin(close)) {
    date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    mins = toMin(open);
  }
  return { date: isoDate(date), mins, isToday: date === now };
}

function fillStartOptions() {
  const { close } = state.meta.rules;
  const slot = nextSlot();
  const select = $('[data-start-options]');
  const options = [];
  for (let m = slot.mins; m + 60 <= toMin(close); m += 30) {
    const label = m === slot.mins && slot.isToday ? `now (${fromMin(m)})` : fromMin(m);
    options.push(h('option', { value: `${slot.date}|${fromMin(m)}` }, slot.isToday ? label : `${longDate(slot.date)} ${label}`));
  }
  select.replaceChildren(...options);
}

function renderNext(bookings) {
  const next = bookings.find((b) => ['approved', 'pending'].includes(b.status));
  const box = $('[data-next]');
  if (!next) {
    box.replaceChildren(h('p', { class: 'muted' }, 'Nothing booked. Find a free room on the right.'));
    return;
  }
  const start = new Date(`${next.date}T${next.start_time}:00`);
  const mins = Math.round((start - Date.now()) / 60000);
  const countdown = mins <= 0 ? 'happening now'
    : mins < 60 ? `in ${mins} min`
    : mins < 24 * 60 ? `in ${Math.floor(mins / 60)} h ${mins % 60} min`
    : `in ${Math.round(mins / 1440)} days`;
  box.replaceChildren(
    h('p', { class: 'next__room mono' }, next.room_code),
    h('p', { class: 'next__title' }, next.title, next.course_code ? ` · ${next.course_code}` : ''),
    h('p', { class: 'next__when mono' }, `${longDate(next.date)} · ${next.start_time}–${next.end_time}`),
    h('p', { class: 'next__meta' },
      h('span', { class: 'mono' }, countdown),
      ` · ${next.room_name}, ${next.building_code}`,
      next.status === 'pending' ? h('span', { class: 'tag tag--pending' }, 'Awaiting approval') : ''),
  );
}

function bookingRow(b) {
  return h('li', { class: `row row--${b.status}` },
    h('span', { class: 'mono row__room' }, b.room_code),
    h('span', { class: 'row__title' }, b.status === 'approved' ? h('span', { class: 'mine-mark', 'aria-hidden': 'true' }, '■ ') : '', b.title),
    h('span', { class: 'mono row__when' }, `${longDate(b.date)} ${b.start_time}–${b.end_time}`),
    h('span', { class: `tag tag--${b.status}` }, b.status));
}

function renderUpcoming(bookings) {
  const list = $('[data-upcoming]');
  list.replaceChildren(...(bookings.length
    ? bookings.slice(0, 8).map(bookingRow)
    : [h('li', { class: 'muted' }, 'No upcoming bookings.')]));
}

function renderNotes({ notifications }) {
  const list = $('[data-notes]');
  list.replaceChildren(...(notifications.length
    ? notifications.slice(0, 6).map((n) => h('li', { class: n.is_read ? 'note' : 'note note--unread' },
      h('p', {}, n.message),
      h('time', { class: 'mono', datetime: n.created_at }, new Date(n.created_at).toLocaleString('en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      }))))
    : [h('li', { class: 'muted' }, 'Nothing new.')]));
}

async function findRooms(form) {
  showError(form.parentElement, '');
  const fd = new FormData(form);
  const [date, start] = String(fd.get('start')).split('|');
  const end = fromMin(Math.min(toMin(start) + Number(fd.get('duration')), toMin(state.meta.rules.close)));
  const people = Math.max(1, Number(fd.get('people')) || 1);
  const list = $('[data-results]');
  list.replaceChildren(h('li', { class: 'muted' }, 'Searching…'));
  try {
    const q = new URLSearchParams({ date, start, end, minCapacity: people });
    const { rooms } = await api(`/rooms/available?${q}`);
    list.replaceChildren(...(rooms.length
      ? rooms.slice(0, 8).map((r) => h('li', { class: 'result' },
        h('span', { class: 'result__code mono' }, r.code),
        h('span', { class: 'result__where' }, r.name, h('small', {}, r.building_name)),
        h('span', { class: 'result__cap mono' }, `${r.capacity} seats`),
        h('span', { class: 'result__fac mono' }, r.facilities.map((f) => f.replace('_', ' ')).join(' · ')),
        r.bestFit ? h('span', { class: 'result__fit' }, `Best fit for ${people}`) : ''))
      : [h('li', { class: 'muted' }, `No room fits ${people} people ${start}–${end}. Try a shorter slot or fewer people.`)]));
  } catch (err) {
    list.replaceChildren();
    showError(form.parentElement, err.message);
  }
}

async function loadDashboard() {
  const [mine, notes] = await Promise.all([api('/bookings/mine'), api('/notifications')]);
  renderNext(mine.bookings);
  renderUpcoming(mine.bookings);
  renderNotes(notes);
}

/* ---------- Views ------------------------------------------------------------------ */

async function enterApp(user) {
  state.user = user;
  state.meta ??= await api('/rooms/meta');
  document.body.classList.replace('is-landing', 'is-app');
  $('[data-view="landing"]').hidden = true;
  $('[data-view="dashboard"]').hidden = false;
  $('[data-signed-in]').hidden = false;
  $('[data-user-name]').textContent = `${user.name} · ${user.role}`;
  $('[data-greeting]').textContent = greeting(user.name);
  $('[data-today]').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  fillStartOptions();
  await loadDashboard();
}

function leaveApp() {
  state.user = null;
  document.body.classList.replace('is-app', 'is-landing');
  $('[data-view="landing"]').hidden = false;
  $('[data-view="dashboard"]').hidden = true;
  $('[data-signed-in]').hidden = true;
  switchForm('login');
}

/* ---------- Start ------------------------------------------------------------------ */

function init() {
  tickClock();
  setInterval(tickClock, 1000);
  startFootage();
  refreshNow();
  setInterval(refreshNow, 60_000);

  $('[data-form="login"]').addEventListener('submit', (e) => { e.preventDefault(); submitAuth(e.target, '/auth/login'); });
  $('[data-form="register"]').addEventListener('submit', (e) => { e.preventDefault(); submitAuth(e.target, '/auth/register'); });
  for (const b of $$('[data-switch]')) b.addEventListener('click', () => switchForm(b.dataset.switch));
  $('[data-form="find"]').addEventListener('submit', (e) => { e.preventDefault(); findRooms(e.target); });
  $('[data-sign-out]').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    leaveApp();
  });

  api('/auth/me').then(({ user }) => enterApp(user)).catch(() => {});
}

init();
