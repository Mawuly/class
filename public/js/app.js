import { api } from './api.js';
import { openSheet } from './sheet.js';
import { showBoard, hideBoard } from './board.js';
import { openCalendarSheet } from './calendar.js';
import { phoneSection } from './phone.js';
import { startPasswordToggles } from './password-toggle.js';
import { showWeek, hideWeek, weekHref } from './week.js';
import { staffFields, ROLE_LABEL } from './access-form.js';
import { openEditSheet, closeEditSheet } from './edit-sheet.js';
import { checkInLine } from './checkin.js';
import { $, $$, h, isoDate, hhmm, toMin, fromMin, longDate, showError } from './util.js';

const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const state = { user: null, meta: null, search: null };

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
  } catch (err) {
    // A setup problem (503) is worth showing: it tells the site owner exactly what to fix.
    if (err.status === 503) {
      $('[data-now-label]').textContent = err.message;
      $('[data-now-label]').classList.add('now__label--problem');
    }
    return; // otherwise keep showing the last numbers
  }
  $('[data-now-label]').classList.remove('now__label--problem');
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

function switchForm(name) {
  for (const f of $$('[data-view="landing"] .auth form')) f.hidden = f.dataset.form !== name;
  if (name === 'forgot') {
    $('[data-forgot-done]').hidden = true;
    $('[data-form="forgot"] [name=email]').value = $('[data-form="login"] [name=email]').value;
    showResetMethod();
  }
  $(`[data-form="${name}"] input`).focus();
}

/** Explains the right steps: a code by email, or the timetable office if email isn't set up. */
async function resetOptions() {
  state.resetOptions ??= await api('/auth/options').catch(() => ({ resetByCode: false, channels: {} }));
  return state.resetOptions;
}

/** Where a code goes, in words: "by text message to … or by email if …". */
function codeRoute({ sms, email }) {
  if (sms && email) return 'by text message to the phone number on your account, or by email if no phone number is saved';
  if (sms) return 'by text message to the phone number on your account';
  return 'by email';
}

async function showResetMethod() {
  const o = await resetOptions();
  for (const el of $$('[data-reset-by]')) el.hidden = el.dataset.resetBy !== (o.resetByCode ? 'email' : 'office');
  if (o.resetByCode) {
    $('[data-reset-by="email"]').textContent = `Enter the email you registered with. We’ll send a 6-digit code ${codeRoute(o.channels)}.`;
  }
  $('[data-forgot-submit]').textContent = o.resetByCode ? 'Send me a code' : 'Tell the timetable office';
}

async function submitAuth(form, path) {
  showError(form, '');
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    const { user } = await api(path, { method: 'POST', body });
    // Signed in with a temporary password: keep it in memory just long enough to choose a new one.
    state.tempPassword = user.mustChangePassword ? body.password : null;
    form.reset();
    await enterApp(user);
  } catch (err) {
    showError(form, err.message);
  } finally {
    button.disabled = false;
  }
}

/* ---------- Sign-up with staff verification ---------------------------------------- */

let registerStaff = null;

function accountType() {
  return $('[data-form="register"] input[name="accountType"]:checked').value;
}

function onAccountTypeChange() {
  const staff = accountType() !== 'student';
  $('[data-student-only]').hidden = staff;
  $('[data-staff-slot]').hidden = !staff;
  $('[data-register-submit]').textContent = staff ? 'Create account and send letter' : 'Create account';
}

async function submitRegister(form) {
  showError(form, '');
  const type = accountType();
  const staff = type !== 'student';
  if (staff) {
    const problem = registerStaff.validate();
    if (problem) { showError(form, problem); return; }
  }
  const button = $('[data-register-submit]', form);
  button.disabled = true;
  try {
    const fd = new FormData(form);
    const body = { name: fd.get('name'), email: fd.get('email'), password: fd.get('password') };
    if (!staff) Object.assign(body, { indexNumber: fd.get('indexNumber'), department: fd.get('department') });
    const { user } = await api('/auth/register', { method: 'POST', body });
    // The account exists now. If sending the letter fails, the dashboard offers to try again.
    if (staff) {
      button.textContent = 'Sending your letter…';
      try {
        await registerStaff.send(type);
      } catch (err) {
        state.accessError = { role: type, message: err.message };
      }
    }
    form.reset();
    registerStaff = staffFields();
    $('[data-staff-slot]').replaceChildren(registerStaff.el);
    onAccountTypeChange();
    await enterApp(user);
  } catch (err) {
    showError(form, err.message);
    onAccountTypeChange();
  } finally {
    button.disabled = false;
  }
}

/* ---------- Staff access: status banner and request sheet --------------------------- */

function since(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Roles this person could ask for here. Timetable office access is asked for on the portal. */
function requestableRoles() {
  return state.user.role === 'student' ? ['lecturer'] : [];
}

function renderAccessBanner(request) {
  const banner = $('[data-access-banner]');
  const roles = requestableRoles();
  const askButton = (label) => h('button', { class: 'link-button', type: 'button', onclick: openAccessSheet }, label);
  let content = null;
  let kind = 'quiet';
  if (state.accessError) {
    kind = 'problem';
    content = [h('p', {}, `Your account was created, but your letter for ${ROLE_LABEL[state.accessError.role].toLowerCase()} `
      + `access was not sent: ${state.accessError.message} `), askButton('Send it again')];
  } else if (request?.status === 'pending') {
    kind = 'pending';
    content = [
      h('p', {}, h('b', {}, `Your request for ${ROLE_LABEL[request.role].toLowerCase()} access is being checked`),
        ` by the timetable office. Until then you have ${state.user.role} access.`),
      h('p', { class: 'mono access-banner__meta' }, `Sent ${since(request.created_at)} · ${request.document_name}`)];
  } else if (request?.status === 'rejected' && roles.includes(request.role)) {
    kind = 'problem';
    content = [h('p', {}, `Your request for ${ROLE_LABEL[request.role].toLowerCase()} access was not approved.`
      + `${request.decision_reason ? ` Reason: ${request.decision_reason.replace(/([^.!?])$/, '$1.')}` : ''} `),
    askButton('Send a new request')];
  } else if (roles.length) {
    content = [h('p', {}, 'Lecturer? ', askButton('Request lecturer access'),
      h('span', { class: 'access-banner__aside' }, ' · Timetable office staff: ', h('a', { href: '/admin' }, 'use the portal')))];
  }
  banner.className = `access-banner access-banner--${kind}`;
  banner.replaceChildren(...(content || []));
  banner.hidden = !content;
}

async function loadAccessBanner() {
  // Admins have nothing to ask for; everyone else may have a request waiting (lecturer access
  // from here, or timetable office access from the portal).
  if (state.user.role === 'admin' && !state.accessError) { renderAccessBanner(null); return; }
  try {
    const { request } = await api('/access-requests/mine');
    renderAccessBanner(request);
  } catch { /* the banner is optional */ }
}

function openAccessSheet() {
  const roles = state.accessError ? [state.accessError.role] : requestableRoles();
  const fields = staffFields({ roles, department: state.user.department || '' });
  const submit = h('button', { class: 'button button--primary', type: 'submit' }, 'Send for checking');
  const form = h('form', { class: 'form', novalidate: true }, fields.el,
    h('p', { class: 'alert', 'data-error': '', hidden: true }),
    h('div', { class: 'sheet__actions' }, submit,
      h('button', { class: 'button button--secondary', type: 'button', onclick: closeEditSheet }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(form, '');
    const problem = fields.validate();
    if (problem) { showError(form, problem); return; }
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      await fields.send();
      state.accessError = null;
      closeEditSheet();
      await loadAccessBanner();
    } catch (err) {
      showError(form, err.message);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Send for checking';
    }
  });
  openEditSheet('Request staff access', form);
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
  const { close, maxHours } = state.meta.rules;
  // How long: whole hours up to the longest booking the office allows.
  const duration = $('[data-form="find"] [name="duration"]');
  const keep = Number(duration.value) || 120;
  duration.replaceChildren(...Array.from({ length: maxHours }, (_, i) => (i + 1) * 60)
    .map((m) => h('option', { value: String(m), selected: m === Math.min(keep, maxHours * 60) }, `${m / 60}h`)));
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
    checkInLine(next, state.meta.rules, { onDone: refreshAfterChange }),
  );
}

/** Cancel needs a second click within a few seconds, so a stray tap cannot drop a booking. */
function cancelButton(b, series = false) {
  let armed = null;
  const label = series ? 'Cancel series' : 'Cancel';
  const button = h('button', {
    class: 'link-button row__cancel', type: 'button',
    'aria-label': series ? `Cancel every remaining week of ${b.title} in ${b.room_code}` : `Cancel ${b.title} in ${b.room_code} on ${longDate(b.date)}`,
  }, label);
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = series ? 'Cancel all weeks?' : 'Confirm cancel?';
      armed = setTimeout(() => { armed = null; button.textContent = label; }, 4000);
      return;
    }
    clearTimeout(armed);
    button.disabled = true;
    try {
      await api(series ? `/bookings/series/${b.series_id}/cancel` : `/bookings/${b.id}/cancel`, { method: 'POST' });
      await refreshAfterChange();
    } catch (err) {
      button.disabled = false;
      button.textContent = err.message;
    }
  });
  return button;
}

function bookingRow(b) {
  return h('li', { class: `row row--${b.status}` },
    h('span', { class: 'mono row__room' }, b.room_code),
    h('span', { class: 'row__title' }, b.status === 'approved' ? h('span', { class: 'mine-mark', 'aria-hidden': 'true' }, '■ ') : '', b.title),
    h('span', { class: 'mono row__when' }, `${longDate(b.date)} ${b.start_time}–${b.end_time}`,
      b.series_id ? h('span', { class: 'row__weekly', title: 'Part of a weekly booking' }, '↻ weekly') : ''),
    h('span', { class: 'row__side' },
      h('span', { class: `tag tag--${b.status}` }, b.status === 'pending' ? 'awaiting approval'
        : b.status === 'released' ? 'released · no check-in'
        : b.checked_in_at ? 'checked in' : b.status),
      ['pending', 'approved'].includes(b.status)
        ? h('span', { class: 'row__cancels' }, cancelButton(b), b.series_id ? cancelButton(b, true) : '')
        : ''));
}

function renderUpcoming(bookings) {
  const list = $('[data-upcoming]');
  // Rejections stay visible so students see the outcome; your own cancellations are just clutter.
  const shown = bookings.filter((b) => b.status !== 'cancelled');
  list.replaceChildren(...(shown.length
    ? shown.slice(0, 8).map(bookingRow)
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
    state.search = { date, start, end, attendees: people };
    list.replaceChildren(...(rooms.length
      ? rooms.slice(0, 8).map((r) => h('li', { class: 'result' },
        h('a', { class: 'result__code mono', href: weekHref(r.id, date), title: `See ${r.code}'s week` }, r.code),
        h('span', { class: 'result__where' }, r.name, h('small', {}, r.building_name)),
        h('span', { class: 'result__cap mono' }, `${r.capacity} seats`),
        h('button', {
          class: 'button button--secondary result__book',
          type: 'button',
          'aria-label': `Book ${r.code}, ${start}–${end}`,
          onclick: () => openSheet(r, state.search, {
            user: state.user, rules: state.meta.rules, onBooked: refreshAfterChange,
          }),
        }, 'Book'),
        h('span', { class: 'result__fac mono' }, r.facilities.map((f) => f.replace('_', ' ')).join(' · ')),
        r.bestFit ? h('span', { class: 'result__fit' }, `Best fit for ${people}`) : ''))
      : [h('li', { class: 'muted' }, `No room fits ${people} people ${start}–${end}. Try a shorter slot or fewer people.`)]));
  } catch (err) {
    list.replaceChildren();
    showError(form.parentElement, err.message);
  }
}

/** After a booking or cancellation: reload my bookings and re-run the last search. */
async function refreshAfterChange() {
  await loadDashboard();
  if (state.search) await findRooms($('[data-form="find"]'));
}

async function loadDashboard() {
  const [mine, notes] = await Promise.all([api('/bookings/mine'), api('/notifications'), loadAccessBanner(), showPhonePrompt()]);
  renderNext(mine.bookings);
  renderUpcoming(mine.bookings);
  renderNotes(notes);
}

/* ---------- Views ------------------------------------------------------------------ */

async function enterApp(user) {
  state.user = user;
  document.body.classList.replace('is-landing', 'is-app');
  $('[data-view="landing"]').hidden = true;
  if (user.mustChangePassword) {
    showPasswordView();
    return;
  }
  $('[data-view="password"]').hidden = true;
  state.meta ??= await api('/rooms/meta');
  $('[data-signed-in]').hidden = false;
  $('[data-user-name]').textContent = `${user.name} · ${user.role}`;
  $('[data-greeting]').textContent = greeting(user.name);
  $('[data-today]').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  fillStartOptions();
  const isAdmin = user.role === 'admin';
  for (const el of $$('[data-admin-only]')) el.hidden = !isAdmin;
  clearInterval(state.badgeTimer);
  if (isAdmin) {
    refreshPendingBadge();
    state.badgeTimer = setInterval(refreshPendingBadge, 60_000);
  }
  // Signed in from a door sign: go back to that door.
  const next = new URLSearchParams(location.search).get('next');
  if (next && /^\/door\?c=[A-Za-z0-9-]{6,7}$/.test(next)) { location.replace(next); return; }
  await route();
  // The next-booking card's check-in button appears and disappears with the clock.
  clearInterval(state.dashTimer);
  state.dashTimer = setInterval(() => {
    if (!$('[data-view="dashboard"]').hidden && !document.hidden) loadDashboard().catch(() => {});
  }, 60_000);
}

const PAGES = { '#/board': 'board' };
const APP_VIEWS = ['dashboard', 'board', 'week'];
// Old links to admin pages on the main site now open the timetable office portal.
const MOVED_TO_PORTAL = ['#/approvals', '#/rooms', '#/people', '#/stats', '#/audit', '#/settings'];

/** Pages for students and lecturers: "#/" dashboard, "#/board" day board, "#/room/12" a room's week. */
async function route() {
  if (!state.user) return;
  if (MOVED_TO_PORTAL.includes(location.hash)) { location.replace(`/admin${location.hash}`); return; }
  // "#/room/12?date=2026-11-16" is one room's week.
  const roomMatch = location.hash.match(/^#\/room\/(\d+)(?:\?date=(\d{4}-\d{2}-\d{2}))?$/);
  const page = roomMatch ? 'week' : PAGES[location.hash] || 'dashboard';
  for (const v of APP_VIEWS) $(`[data-view="${v}"]`).hidden = v !== page;
  // Data-heavy pages keep the top bar fixed as glass over the scrolling page.
  document.body.classList.toggle('is-board', page !== 'dashboard');
  // The week view belongs under the day board in the navigation.
  for (const a of $$('[data-nav]')) a.toggleAttribute('aria-current', a.dataset.nav === (page === 'week' ? 'board' : page));
  if (page === 'week') showWeek({ user: state.user, rules: state.meta.rules }, Number(roomMatch[1]), roomMatch[2]);
  else hideWeek();
  if (page === 'board') showBoard({ user: state.user, rules: state.meta.rules, buildings: state.meta.buildings });
  else hideBoard();
  if (page === 'dashboard') await loadDashboard();
}

/** Admins see how much is waiting for them, on the link to the timetable office portal. */
async function refreshPendingBadge() {
  if (state.user?.role !== 'admin') return;
  try {
    const { bookings, access } = await api('/admin/pending-counts');
    const n = bookings + access;
    const badge = $('[data-pending-badge]');
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = !n;
    $('.topbar__link--portal').setAttribute('aria-label', n ? `Timetable office, ${n} waiting` : 'Timetable office');
  } catch { /* keep the last count */ }
}

/* ---------- Passwords -------------------------------------------------------------- */

async function submitForgot(form) {
  showError(form, '');
  const email = form.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError(form, 'Enter the email you registered with'); return; }
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const r = await api('/auth/forgot-password', { method: 'POST', body: { email } });
    if (r.method === 'code') {
      openCodeStep(email, r.minutes);
      return;
    }
    const done = $('[data-forgot-done]', form);
    done.textContent = `Done. If ${email} has an account, the timetable office has been told. `
      + 'Visit or call them with your ID card to get a temporary password.';
    done.hidden = false;
  } catch (err) {
    showError(form, err.message);
  } finally {
    button.disabled = false;
  }
}

/* Step 2 of a reset by email. The "send a new code" link waits a minute, as the server does. */
function openCodeStep(email, minutes) {
  state.resetEmail = email;
  const form = $('[data-form="reset-code"]');
  form.reset();
  showError(form, '');
  const ch = state.resetOptions?.channels || { email: true };
  $('[data-code-title]', form).textContent = ch.sms ? 'Check your phone' : 'Check your email';
  $('[data-code-sent]', form).textContent = `If ${email} has an account, we’ve sent a 6-digit code ${codeRoute(ch)}. `
    + `It works for ${minutes} minutes.`;
  switchForm('reset-code');
  startResendWait();
}

function startResendWait() {
  const link = $('[data-resend]');
  clearInterval(state.resendTimer);
  let left = 60;
  link.disabled = true;
  link.textContent = `send a new code in ${left} s`;
  state.resendTimer = setInterval(() => {
    left -= 1;
    if (left > 0) { link.textContent = `send a new code in ${left} s`; return; }
    clearInterval(state.resendTimer);
    link.disabled = false;
    link.textContent = 'send a new code';
  }, 1000);
}

async function resendCode() {
  const form = $('[data-form="reset-code"]');
  showError(form, '');
  try {
    await api('/auth/forgot-password', { method: 'POST', body: { email: state.resetEmail } });
    $('[data-code-sent]', form).textContent = `We’ve sent a new code to ${state.resetEmail}, if it has an account. `
      + 'Only the newest code works.';
    startResendWait();
  } catch (err) {
    showError(form, err.message);
  }
}

async function submitCode(form) {
  showError(form, '');
  const code = form.code.value.replace(/\D/g, '');
  if (code.length !== 6) { showError(form, 'Enter the 6 digits from the email'); form.code.focus(); return; }
  const problem = passwordProblem(form.newPassword.value, form.repeat.value);
  if (problem) { showError(form, problem); return; }
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const { user } = await api('/auth/reset-password', {
      method: 'POST', body: { email: state.resetEmail, code, newPassword: form.newPassword.value },
    });
    clearInterval(state.resendTimer);
    form.reset();
    await enterApp(user);
  } catch (err) {
    showError(form, err.message);
  } finally {
    button.disabled = false;
  }
}

/** Shown instead of the app until someone who signed in with a temporary password picks their own. */
function showPasswordView() {
  for (const v of APP_VIEWS) $(`[data-view="${v}"]`).hidden = true;
  $('[data-signed-in]').hidden = true;
  hideBoard();
  const view = $('[data-view="password"]');
  view.hidden = false;
  const form = $('[data-form="new-password"]', view);
  form.reset();
  showError(form, '');
  // If we still have the temporary password from the sign-in just now, don't ask for it again.
  $('[data-temp-field]', form).hidden = Boolean(state.tempPassword);
  $(state.tempPassword ? '[name=newPassword]' : '[name=currentPassword]', form).focus();
}

function passwordProblem(pw, repeat) {
  if (pw.length < 8) return 'Use at least 8 characters';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use at least one letter and one number';
  if (pw !== repeat) return 'The two new passwords are different';
  return null;
}

async function submitNewPassword(form) {
  showError(form, '');
  const currentPassword = state.tempPassword || form.currentPassword.value;
  const problem = !currentPassword ? 'Enter the temporary password' : passwordProblem(form.newPassword.value, form.repeat.value);
  if (problem) { showError(form, problem); return; }
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const { user } = await api('/auth/change-password', {
      method: 'POST', body: { currentPassword, newPassword: form.newPassword.value },
    });
    state.tempPassword = null;
    form.reset();
    await enterApp(user);
  } catch (err) {
    // A wrong remembered password (e.g. typed with a slip) falls back to asking for it.
    if (/current password/i.test(err.message)) {
      state.tempPassword = null;
      $('[data-temp-field]', form).hidden = false;
    }
    showError(form, err.message);
  } finally {
    button.disabled = false;
  }
}

async function openAccountSheet() {
  await resetOptions();
  const u = state.user;
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), input,
    hint ? h('span', { class: 'field__hint' }, hint) : null);
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  const repeat = h('input', { type: 'password', autocomplete: 'new-password' });
  const done = h('p', { class: 'auth__done', role: 'status', hidden: true });
  const submit = h('button', { class: 'button button--primary', type: 'submit' }, 'Change password');
  const form = h('form', { class: 'form', novalidate: true },
    h('h3', { class: 'panel__title' }, 'Change password'),
    field('Current password', current),
    field('New password', next, '8 or more characters, with a letter and a number'),
    field('New password again', repeat),
    h('p', { class: 'alert', 'data-error': '', hidden: true }),
    done,
    h('div', { class: 'sheet__actions' }, submit,
      h('button', { class: 'button button--secondary', type: 'button', onclick: closeEditSheet }, 'Close')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(form, '');
    done.hidden = true;
    const problem = !current.value ? 'Enter your current password' : passwordProblem(next.value, repeat.value);
    if (problem) { showError(form, problem); return; }
    submit.disabled = true;
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } });
      form.reset();
      done.textContent = 'Password changed. Anywhere else you were signed in has been signed out.';
      done.hidden = false;
    } catch (err) {
      showError(form, err.message);
    } finally {
      submit.disabled = false;
    }
  });
  openEditSheet('Your account',
    h('div', { class: 'requester' },
      h('p', { class: 'requester__name serif' }, u.name),
      h('p', { class: 'requester__meta mono' }, u.email),
      h('p', { class: 'requester__ago' }, [u.role[0].toUpperCase() + u.role.slice(1), u.department, u.indexNumber && `Index ${u.indexNumber}`]
        .filter(Boolean).join(' · '))),
    state.resetOptions?.channels?.sms ? phoneSection(u, (phone) => { u.phone = phone; showPhonePrompt(); }) : null,
    form);
  current.focus();
}

/** When codes can be texted, nudge people without a confirmed number to add one. */
async function showPhonePrompt() {
  const prompt = $('[data-phone-prompt]');
  const o = await resetOptions();
  prompt.hidden = !(o.channels?.sms && state.user && !state.user.phone);
}

function leaveApp() {
  state.user = null;
  clearInterval(state.dashTimer);
  state.tempPassword = null;
  state.accessError = null;
  $('[data-view="password"]').hidden = true;
  document.body.classList.replace('is-app', 'is-landing');
  $('[data-view="landing"]').hidden = false;
  for (const v of APP_VIEWS) $(`[data-view="${v}"]`).hidden = true;
  for (const el of $$('[data-admin-only]')) el.hidden = true;
  clearInterval(state.badgeTimer);
  $('[data-signed-in]').hidden = true;
  document.body.classList.remove('is-board');
  hideBoard();
  hideWeek();
  switchForm('login');
}

/* ---------- Start ------------------------------------------------------------------ */

function init() {
  startPasswordToggles();
  tickClock();
  setInterval(tickClock, 1000);
  startFootage();
  refreshNow();
  setInterval(refreshNow, 60_000);

  $('[data-form="login"]').addEventListener('submit', (e) => { e.preventDefault(); submitAuth(e.target, '/auth/login'); });
  $('[data-form="register"]').addEventListener('submit', (e) => { e.preventDefault(); submitRegister(e.target); });
  registerStaff = staffFields();
  $('[data-staff-slot]').replaceChildren(registerStaff.el);
  for (const r of $$('[data-form="register"] input[name="accountType"]')) r.addEventListener('change', onAccountTypeChange);
  for (const b of $$('[data-switch]')) b.addEventListener('click', () => switchForm(b.dataset.switch));
  window.addEventListener('hashchange', () => { route(); });
  $('[data-form="find"]').addEventListener('submit', (e) => { e.preventDefault(); findRooms(e.target); });
  for (const b of $$('[data-sign-out]')) {
    b.addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      leaveApp();
    });
  }
  $('[data-form="forgot"]').addEventListener('submit', (e) => { e.preventDefault(); submitForgot(e.target); });
  $('[data-form="reset-code"]').addEventListener('submit', (e) => { e.preventDefault(); submitCode(e.target); });
  $('[data-resend]').addEventListener('click', resendCode);
  // Typing or pasting "482913" shows as "482 913", easier to compare with the email.
  $('[data-form="reset-code"] [name=code]').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
    e.target.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
  });
  $('[data-form="new-password"]').addEventListener('submit', (e) => { e.preventDefault(); submitNewPassword(e.target); });
  $('[data-account]').addEventListener('click', openAccountSheet);
  $('[data-calendar]').addEventListener('click', openCalendarSheet);
  $('[data-phone-prompt] button').addEventListener('click', openAccountSheet);
  // The server says a new password is needed (e.g. reset by an admin while this tab was open).
  window.addEventListener('must-change-password', () => {
    if (!state.user) return;
    state.user.mustChangePassword = true;
    showPasswordView();
  });

  api('/auth/me').then(({ user }) => enterApp(user)).catch(() => {});
}

init();
