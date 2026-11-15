import { api } from './api.js';
import { openSheet } from './sheet.js';
import { showBoard, hideBoard } from './board.js';
import { showApprovals, pendingCount } from './approvals.js';
import { showRooms } from './rooms-admin.js';
import { showPeople } from './people-admin.js';
import { showStats } from './stats.js';
import { staffFields, ROLE_LABEL } from './access-form.js';
import { openEditSheet, closeEditSheet } from './edit-sheet.js';
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
  }
  $(`[data-form="${name}"] input`).focus();
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

/** Roles this person could still ask for. */
function requestableRoles() {
  return { student: ['lecturer', 'admin'], lecturer: ['admin'] }[state.user.role] || [];
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
    content = [h('p', {}, state.user.role === 'student' ? 'Staff member? ' : 'Work in the timetable office? ',
      askButton(state.user.role === 'student' ? 'Request lecturer or admin access' : 'Request admin access'))];
  }
  banner.className = `access-banner access-banner--${kind}`;
  banner.replaceChildren(...(content || []));
  banner.hidden = !content;
}

async function loadAccessBanner() {
  if (!requestableRoles().length && !state.accessError) { renderAccessBanner(null); return; }
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

/** Cancel needs a second click within a few seconds, so a stray tap cannot drop a booking. */
function cancelButton(b) {
  let armed = null;
  const button = h('button', { class: 'link-button row__cancel', type: 'button', 'aria-label': `Cancel ${b.title} in ${b.room_code}` }, 'Cancel');
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = 'Confirm cancel?';
      armed = setTimeout(() => { armed = null; button.textContent = 'Cancel'; }, 4000);
      return;
    }
    clearTimeout(armed);
    button.disabled = true;
    try {
      await api(`/bookings/${b.id}/cancel`, { method: 'POST' });
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
    h('span', { class: 'mono row__when' }, `${longDate(b.date)} ${b.start_time}–${b.end_time}`),
    h('span', { class: 'row__side' },
      h('span', { class: `tag tag--${b.status}` }, b.status === 'pending' ? 'awaiting approval' : b.status),
      ['pending', 'approved'].includes(b.status) ? cancelButton(b) : ''));
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
        h('span', { class: 'result__code mono' }, r.code),
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
  const [mine, notes] = await Promise.all([api('/bookings/mine'), api('/notifications'), loadAccessBanner()]);
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
  await route();
}

const PAGES = { '#/board': 'board', '#/approvals': 'approvals', '#/rooms': 'rooms', '#/people': 'people', '#/stats': 'stats' };
const APP_VIEWS = ['dashboard', 'board', 'approvals', 'rooms', 'people', 'stats'];
const ADMIN_PAGES = ['approvals', 'rooms', 'people', 'stats'];

/** Signed-in pages: "#/" dashboard, "#/board" day board; admins also approvals, rooms and people. */
async function route() {
  if (!state.user) return;
  let page = PAGES[location.hash] || 'dashboard';
  if (ADMIN_PAGES.includes(page) && state.user.role !== 'admin') page = 'dashboard';
  for (const v of APP_VIEWS) $(`[data-view="${v}"]`).hidden = v !== page;
  // Data-heavy pages keep the top bar fixed as glass over the scrolling page.
  document.body.classList.toggle('is-board', page !== 'dashboard');
  for (const a of $$('[data-nav]')) a.toggleAttribute('aria-current', a.dataset.nav === page);
  if (page === 'board') showBoard({ user: state.user, rules: state.meta.rules, buildings: state.meta.buildings });
  else hideBoard();
  if (page === 'approvals') showApprovals({ onCountChange: setPendingBadge });
  // After a room edit, refresh the cached building and facility lists used by the board and search.
  if (page === 'people') showPeople({ me: state.user });
  if (page === 'stats') showStats({ buildings: state.meta.buildings });
  if (page === 'rooms') showRooms({ onChange: async () => { state.meta = await api('/rooms/meta'); } });
  if (page === 'dashboard') await loadDashboard();
}

function setPendingBadge(n) {
  const badge = $('[data-pending-badge]');
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = !n;
  $('[data-nav="approvals"]').setAttribute('aria-label', n ? `Approvals, ${n} waiting` : 'Approvals');
}

async function refreshPendingBadge() {
  if (state.user?.role !== 'admin') return;
  try { setPendingBadge(await pendingCount()); } catch { /* keep the last count */ }
}

/* ---------- Passwords -------------------------------------------------------------- */

async function submitForgot(form) {
  showError(form, '');
  const email = form.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError(form, 'Enter the email you registered with'); return; }
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    await api('/auth/forgot-password', { method: 'POST', body: { email } });
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

function openAccountSheet() {
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
    form);
  current.focus();
}

function leaveApp() {
  state.user = null;
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
  $('[data-form="new-password"]').addEventListener('submit', (e) => { e.preventDefault(); submitNewPassword(e.target); });
  $('[data-account]').addEventListener('click', openAccountSheet);
  // The server says a new password is needed (e.g. reset by an admin while this tab was open).
  window.addEventListener('must-change-password', () => {
    if (!state.user) return;
    state.user.mustChangePassword = true;
    showPasswordView();
  });

  api('/auth/me').then(({ user }) => enterApp(user)).catch(() => {});
}

init();
