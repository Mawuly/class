// UCC Spaces: the public site. Rooms come from the API, sign-in is the university account,
// and every booking is written to the database. Admin tools live at /admin.
import { api } from './api.js';
import { currentPosition, locationNote } from './location.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const button = (text, cls, fn) => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
};
/** "Directions": Google Maps walking directions to the room's building, in a new tab (the Maps app on phones). */
function directionsLink(url, place) {
  const a = el('a', 'directions-link', 'Directions');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.setAttribute('aria-label', `Walking directions to ${place} (opens Google Maps)`);
  return a;
}

function optionEl(value, label) { const o = el('option', '', label); o.value = value; return o; }
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = localDate();
const tomorrow = localDate(new Date(Date.now() + 86400000));
const clock = (t) => {
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${pad(m)} ${suffix}`;
};
const dayLabel = (date) => new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short',
});
const TYPE = {
  lecture_hall: 'Lecture hall', lab: 'Laboratory', seminar: 'Seminar room',
  study: 'Study room', meeting: 'Meeting room',
};
const ROLE = { student: 'Student', lecturer: 'Lecturer', admin: 'Timetable office' };
const HOLDS = ['pending', 'approved'];

const state = {
  user: null,
  rooms: [],
  bookings: [],
  rules: { open: '06:30', close: '20:30', maxHours: 4 },
  date: tomorrow,
  building: '',
  availableOnly: false,
  limit: 15,
  start: '',   // chosen start time, HH:MM
  hours: 1,    // chosen length in whole hours
};

/* ---------- Choosing a time ---------------------------------------------------------- */

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** Start times every half hour (from the next half hour, today) and lengths of 1 to maxHours. */
function fillTimeOptions() {
  const { open, close, maxHours } = state.rules;
  let first = toMin(open);
  if (state.date === today) {
    const now = new Date();
    first = Math.max(first, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30);
  }
  const starts = [];
  for (let m = first; m + 60 <= toMin(close); m += 30) starts.push(fromMin(m));
  const startSel = $('start-time');
  startSel.replaceChildren(...(starts.length ? starts : ['']).map((t) => optionEl(t, t ? clock(t) : 'No times left today')));
  // Keep the chosen time if it is still possible; otherwise the first one (or 10:00 on another day).
  const preferred = state.date === today ? starts[0] : (starts.includes('10:00') ? '10:00' : starts[0]);
  state.start = starts.includes(state.start) ? state.start : (preferred || '');
  startSel.value = state.start;
  startSel.disabled = !starts.length;
  const roomLeft = state.start ? Math.floor((toMin(close) - toMin(state.start)) / 60) : 1;
  const max = Math.max(1, Math.min(maxHours, roomLeft));
  state.hours = Math.min(state.hours, max);
  $('duration').replaceChildren(...Array.from({ length: max }, (_, i) => optionEl(String(i + 1), `${i + 1} hour${i ? 's' : ''}`)));
  $('duration').value = String(state.hours);
}

/**
 * For each room: is it free for the chosen time (r.free is then exactly that slot), and if not,
 * the next free slot of the same length that day (r.next). Uses the free periods from the server.
 */
function applyTime() {
  const len = state.hours * 60;
  const s = state.start ? toMin(state.start) : null;
  for (const r of state.rooms) {
    const periods = r.freePeriods || [];
    const fits = s != null && periods.some((p) => toMin(p.start) <= s && s + len <= toMin(p.end));
    r.free = fits ? { start: state.start, end: fromMin(s + len) } : null;
    r.next = null;
    if (!fits) {
      const slots = periods.map((p) => {
        const from = Math.max(toMin(p.start), s ?? 0);
        const start = Math.ceil(from / 30) * 30;
        return start + len <= toMin(p.end) ? { start: fromMin(start), end: fromMin(start + len) } : null;
      }).filter(Boolean);
      // The next one after the chosen time; failing that, the earliest one that day.
      r.next = slots[0] || periods.map((p) => (toMin(p.end) - toMin(p.start) >= len ? { start: p.start, end: fromMin(toMin(p.start) + len) } : null)).find(Boolean) || null;
    }
  }
}
let pendingAction = null;
let selectedRoom = null;
let selectedSlot = null;

/* ---------- Account ---------------------------------------------------------------- */

function renderAccount() {
  const box = $('account-actions');
  box.replaceChildren();
  if (!state.user) {
    box.append(
      button('Sign in', 'text-button', () => openAuth('login')),
      button('Create account', 'primary', () => openAuth('register')),
    );
    return;
  }
  box.append(
    el('span', 'account-name', `${state.user.name} · ${ROLE[state.user.role] || state.user.role}`),
    button('Sign out', 'text-button', signOut),
  );
}

function requireAccount(action) {
  if (state.user) return true;
  pendingAction = action;
  openAuth('login');
  return false;
}

function openAuth(view = 'login') {
  showAuthView(view);
  $('auth-dialog').showModal();
  document.querySelector(`#auth-${view} input`)?.focus();
}

function showAuthView(view) {
  for (const form of document.querySelectorAll('.auth-form')) form.hidden = form.id !== `auth-${view}`;
  $('auth-error').textContent = '';
  $('auth-note').textContent = '';
  if ($('auth-dialog').open) document.querySelector(`#auth-${view} input`)?.focus();
}

function closeAuth() {
  pendingAction = null;
  $('auth-dialog').close();
}

async function afterAuth(user, message) {
  state.user = user;
  if (user.mustChangePassword) {
    $('auth-dialog').close();
    toast('Choose a new password before making a booking.');
    location.assign('/account.html#change');
    return;
  }
  await Promise.all([loadBookings(), loadRooms()]);
  render();
  $('auth-dialog').close();
  const next = pendingAction;
  pendingAction = null;
  if (message) toast(message);
  if (next) next();
}

async function signOut() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* already signed out */ }
  state.user = null;
  state.bookings = [];
  render();
  openPage('discover');
  toast('Signed out.');
}

/* ---------- Auth forms ------------------------------------------------------------- */

$('auth-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  const email = $('login-email').value.trim().toLowerCase();
  const password = $('login-password').value;
  if (!email || !password) { $('auth-error').textContent = 'Enter your email and password.'; return; }
  const submit = e.target.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { user } = await api('/auth/login', { method: 'POST', body: { email, password } });
    e.target.reset();
    await afterAuth(user, `Signed in as ${user.name}.`);
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

$('auth-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  const name = $('reg-name').value.trim();
  const email = $('reg-email').value.trim().toLowerCase();
  const password = $('reg-password').value;
  if (name.length < 2) { $('auth-error').textContent = 'Enter your full name.'; return; }
  if (password !== $('reg-confirm').value) { $('auth-error').textContent = 'Passwords do not match.'; return; }
  const submit = e.target.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { user } = await api('/auth/register', { method: 'POST', body: { name, email, password } });
    e.target.reset();
    await afterAuth(user, 'Account created.');
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

$('auth-forgot').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  const email = $('forgot-email').value.trim().toLowerCase();
  const submit = e.target.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api('/auth/forgot-password', { method: 'POST', body: { email } });
    $('reset-email').value = email;
    showAuthView('reset');
    $('auth-note').textContent = result.method === 'code'
      ? `If your account is eligible, a 6-digit code has been sent to your email or verified phone. It expires in ${result.minutes || 10} minutes.`
      : 'Contact the timetable office with your student or staff ID to reset your password.';
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

$('auth-reset').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  const email = $('reset-email').value.trim().toLowerCase();
  const code = $('reset-code').value.trim();
  const password = $('reset-password').value;
  if (password !== $('reset-confirm').value) { $('auth-error').textContent = 'Passwords do not match.'; return; }
  const submit = e.target.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { user } = await api('/auth/reset-password', {
      method: 'POST', body: { email, code, newPassword: password },
    });
    e.target.reset();
    await afterAuth(user, 'Password reset.');
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

document.querySelectorAll('[data-auth-view]').forEach((b) => b.addEventListener('click', () => showAuthView(b.dataset.authView)));
$('close-auth').addEventListener('click', closeAuth);

/* ---------- Rooms ------------------------------------------------------------------ */

async function loadRooms() {
  const date = $('date').value || state.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) {
    $('search-error').textContent = 'Choose today or a future date.';
    state.rooms = [];
    renderBuildings();
    renderRooms();
    return;
  }
  state.date = date;
  $('search-error').textContent = '';
  try {
    const data = await api(`/public/rooms?date=${encodeURIComponent(date)}`);
    state.rooms = data.rooms;
    state.rules = { open: data.open, close: data.close, maxHours: data.maxHours };
    fillTimeOptions();
    applyTime();
  } catch (err) {
    state.rooms = [];
    $('search-error').textContent = err.status >= 500
      ? 'Classrooms are temporarily unavailable. Please try again shortly.'
      : err.message;
  }
  renderBuildings();
  renderRooms();
}

function shortBuilding(name) {
  if (/Sandwich/i.test(name)) return 'Sandwich';
  if (/New Lecture/i.test(name)) return 'New';
  if (/Ackah/i.test(name)) return 'C. A. Ackah';
  return name;
}

function buildingList() {
  const groups = new Map();
  for (const r of state.rooms) {
    if (!groups.has(r.building_code)) {
      groups.set(r.building_code, { code: r.building_code, name: r.building_name, count: 0 });
    }
    groups.get(r.building_code).count += 1;
  }
  return [...groups.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function renderBuildings() {
  const list = buildingList();
  // Counted from the rooms the server sends, so they follow what the timetable office has set up.
  const pad = (n) => String(n).padStart(2, '0');
  $('rooms-stat').textContent = state.rooms.length ? String(state.rooms.length) : '—';
  $('buildings-stat').textContent = list.length ? pad(list.length) : '—';
  const cards = list.map((b) => {
    const c = button('', `building-card${state.building === b.code ? ' active' : ''}`, () => {
      state.building = state.building === b.code ? '' : b.code;
      $('building').value = state.building;
      state.limit = 15;
      render();
    });
    c.setAttribute('aria-pressed', String(state.building === b.code));
    const art = el('div', `building-visual ${b.code.toLowerCase()}`);
    art.append(el('span', 'building-code', b.code));
    const info = el('div', 'building-info');
    const sub = el('p');
    sub.append(el('span', '', `${b.count} classrooms`), el('span', '', 'Explore'));
    info.append(el('h3', '', b.name), sub);
    c.append(art, info);
    return c;
  });
  $('buildings').replaceChildren(...cards);

  const select = $('building');
  const current = state.building;
  select.replaceChildren(optionEl('', 'All theatres'), ...list.map((b) => optionEl(b.code, `${shortBuilding(b.name)} · ${b.code}`)));
  select.value = current && list.some((b) => b.code === current) ? current : '';
}

function roomCard(r) {
  const card = el('article', 'room-card');
  const top = el('div', 'room-top');
  const periods = r.freePeriods || [];
  const status = r.free ? 'Available' : periods.length ? `Busy at ${clock(state.start)}` : 'Fully booked';
  top.append(el('h3', '', r.code), el('span', `status ${r.free ? 'available' : 'unavailable'}`, status));
  card.append(top, el('p', '', r.name));
  card.append(el('p', 'room-detail', `${TYPE[r.type] || 'Classroom'} · ${r.capacity} seats`));
  // When it is free: the chosen time, or the free periods that day.
  card.append(el('p', 'room-when', r.free
    ? `${clock(r.free.start)} – ${clock(r.free.end)} · ${dayLabel(state.date)}`
    : periods.length
      ? `Free ${periods.slice(0, 3).map((p) => `${clock(p.start)} – ${clock(p.end)}`).join(', ')}${periods.length > 3 ? ', …' : ''} · ${dayLabel(state.date)}`
      : `No availability · ${dayLabel(state.date)}`));
  const staffOnly = state.user?.role === 'student' && r.bookable_by !== 'all';
  const slot = r.free || r.next;
  const label = staffOnly ? 'Staff only'
    : r.free ? 'Request this room'
      : r.next ? `Request ${clock(r.next.start)} – ${clock(r.next.end)}`
        : periods.length ? `No ${state.hours} h slot free` : 'Fully booked';
  const book = button(label, '', () => requestRoom(r, slot));
  book.disabled = !slot || staffOnly;
  card.append(book);
  if (r.directions) card.append(directionsLink(r.directions, `${r.code}, ${r.building_name}`));
  return card;
}

function renderRooms() {
  const items = state.rooms.filter((r) => !state.building || r.building_code === state.building);
  const free = items.filter((r) => r.free).length;
  $('free-stat').textContent = items.length ? `${free} of ${items.length}` : '—';
  const shown = state.availableOnly ? items.filter((r) => r.free) : items;
  const where = state.building ? ` in ${state.building}` : ' across all theatres';
  $('result-count').textContent = `${shown.length} of ${items.length} rooms${where}`;
  const visible = shown.slice(0, state.limit);
  $('rooms').replaceChildren(...visible.map(roomCard));
  const more = $('more-rooms');
  more.hidden = shown.length <= state.limit;
  more.textContent = `Show more rooms (${Math.min(state.limit + 15, shown.length)} of ${shown.length})`;
  if (!shown.length) {
    $('rooms').append(el('p', 'empty', $('search-error').textContent
      ? 'Classrooms could not be loaded.'
      : 'No rooms match this selection. Try another theatre.'));
  }
}

function requestRoom(room, period) {
  if (!period) return;
  if (!requireAccount(() => requestRoom(room, period))) return;
  if (state.user.role === 'student' && room.bookable_by !== 'all') {
    toast(`${room.code} is available to staff bookings only.`);
    return;
  }
  selectedRoom = room;
  selectedSlot = { ...period };
  const staff = state.user.role !== 'student';
  $('booking-title').textContent = `${staff ? 'Book' : 'Request'} ${room.code}`;
  $('booking-slot').textContent = `${room.name} · ${dayLabel(period.date || state.date)} · ${clock(period.start)} – ${clock(period.end)}`;
  $('booking-note').textContent = staff ? 'Confirmed straight away.' : 'Approval required.';
  $('booking-error').textContent = '';
  $('purpose').value = '';
  $('course-code').value = '';
  $('supervisor').value = '';
  $('booking-dialog').showModal();
  $('purpose').focus();
}

$('booking-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!requireAccount(() => $('booking-form').requestSubmit())) return;
  const purpose = $('purpose').value.trim();
  const courseCode = $('course-code').value.trim().toUpperCase();
  const supervisor = $('supervisor').value.trim();
  if (!purpose) { $('booking-error').textContent = 'Enter the course or activity.'; return; }
  if (!selectedRoom || !selectedSlot) return;
  const submit = e.target.querySelector('[type="submit"]');
  submit.disabled = true;
  $('booking-error').textContent = '';
  try {
    const { booking } = await api('/bookings', {
      method: 'POST',
      body: {
        roomId: selectedRoom.id,
        title: purpose,
        courseCode: courseCode || undefined,
        supervisor: supervisor || undefined,
        date: state.date,
        start: selectedSlot.start,
        end: selectedSlot.end,
      },
    });
    $('booking-dialog').close();
    toast(booking.status === 'approved'
      ? `Booked ${booking.room_code} for ${dayLabel(booking.date)}.`
      : 'Request sent. Awaiting approval.');
    await Promise.all([loadRooms(), loadBookings()]);
  } catch (err) {
    $('booking-error').textContent = err.message;
    if (err.status === 409) loadRooms();
  } finally {
    submit.disabled = false;
  }
});

$('close-dialog').addEventListener('click', () => $('booking-dialog').close());

/* ---------- My bookings ------------------------------------------------------------ */

async function loadBookings() {
  if (!state.user) {
    state.bookings = [];
    renderRecords();
    return;
  }
  try {
    const { bookings } = await api('/bookings/mine');
    state.bookings = bookings;
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      state.bookings = [];
    } else {
      toast(err.message);
    }
  }
  renderRecords();
}

function badge(status) {
  const label = {
    pending: 'Pending approval', approved: 'Approved', rejected: 'Rejected',
    cancelled: 'Cancelled', released: 'Released',
  }[status] || status;
  const cls = ['pending', 'approved', 'rejected', 'cancelled', 'released'].includes(status) ? status : 'unavailable';
  return el('span', `status ${cls}`, label);
}

function formatDoorCode(value) {
  const raw = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
}

let checkInTarget = null;

function bookingRecord(b) {
  const card = el('article', 'record');
  const copy = el('div');
  const extra = [b.course_code, b.supervisor].filter(Boolean).join(' · ');
  copy.append(
    el('h3', '', `${b.room_code} · ${b.title}`),
    el('p', '', `${dayLabel(b.date)} · ${clock(b.start_time)} – ${clock(b.end_time)}${extra ? ` · ${extra}` : ''}`),
  );
  const stateName = b.check_in_state;
  if (stateName === 'early' && b.date === today) {
    copy.append(el('p', 'record-note', `Check in at the door from ${clock(b.check_in_opens_at)} until ${clock(b.check_in_by)}.`));
  } else if (stateName === 'open') {
    copy.append(el('p', 'record-note', `Check in by ${clock(b.check_in_by)}, or the room may be released.`));
  } else if (stateName === 'checked-in') {
    copy.append(el('p', 'record-note', 'Checked in. Check out when you leave so the rest of the room is free.'));
  }
  const actions = el('div', 'record-actions');
  actions.append(badge(b.status));
  if (stateName === 'open') actions.append(button('Check in', 'primary', () => openCheckIn(b)));
  if (stateName === 'checked-in') actions.append(button('Check out', 'primary', () => checkOutBooking(b)));
  if (b.directions && HOLDS.includes(b.status)) actions.append(directionsLink(b.directions, `${b.room_code}, ${b.building_name}`));
  if (HOLDS.includes(b.status) && stateName !== 'checked-out') {
    actions.append(button('Cancel', 'text-button', () => cancelBooking(b)));
  }
  card.append(copy, actions);
  return card;
}

function renderRecords() {
  const held = state.bookings.filter((b) => HOLDS.includes(b.status)).length;
  $('booking-count').textContent = String(held);
  $('my-bookings').replaceChildren(...(state.bookings.length
    ? state.bookings.map(bookingRecord)
    : [el('p', 'empty', state.user ? 'No bookings yet.' : 'Sign in to see your bookings.')]));
}

async function cancelBooking(b) {
  if (!confirm(`Cancel your booking for ${b.room_code} on ${dayLabel(b.date)}?`)) return;
  try {
    await api(`/bookings/${b.id}/cancel`, { method: 'POST' });
    toast('Booking cancelled.');
    await Promise.all([loadBookings(), loadRooms()]);
  } catch (err) {
    toast(err.message);
  }
}

function openCheckIn(b) {
  checkInTarget = b;
  $('checkin-slot').textContent = `${b.room_code} · ${dayLabel(b.date)} · ${clock(b.start_time)} – ${clock(b.end_time)}`;
  $('door-code').value = '';
  $('checkin-error').textContent = '';
  $('checkin-dialog').showModal();
  $('door-code').focus();
}

$('door-code').addEventListener('input', () => {
  $('door-code').value = formatDoorCode($('door-code').value);
});

$('close-checkin').addEventListener('click', () => $('checkin-dialog').close());

$('checkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('door-code').value.replace(/-/g, '');
  if (code.length !== 6) {
    $('checkin-error').textContent = 'Type the six letters and numbers from the sign.';
    return;
  }
  const submit = e.target.querySelector('[type="submit"]');
  submit.disabled = true;
  $('checkin-error').textContent = '';
  try {
    // The phone's position only labels the check-in for the timetable office; it never blocks it.
    const position = await currentPosition();
    const res = await api('/door/check-in', { method: 'POST', body: { code, via: 'code', position } });
    $('checkin-dialog').close();
    toast(`Checked in to ${checkInTarget?.room_code || 'your room'}. ${locationNote(res.location)}`.trim());
    await loadBookings();
  } catch (err) {
    $('checkin-error').textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

async function checkOutBooking(b) {
  if (!confirm(`Check out of ${b.room_code} now? The rest of this booking becomes free for others.`)) return;
  try {
    await api(`/bookings/${b.id}/check-out`, { method: 'POST' });
    toast(`Checked out of ${b.room_code}. The room is free for the rest of that time.`);
    await Promise.all([loadBookings(), loadRooms()]);
  } catch (err) {
    toast(err.message);
  }
}

/* ---------- Pages and filters ------------------------------------------------------ */

const PAGES = { discover: 'Find a classroom', bookings: 'My bookings' };
function openPage(name) {
  if (!PAGES[name]) return;
  if (name === 'bookings' && !requireAccount(() => openPage(name))) return;
  for (const n of Object.keys(PAGES)) $(`${n}-page`).hidden = n !== name;
  document.querySelectorAll('[data-page]').forEach((b) => b.classList.toggle('selected', b.dataset.page === name));
  $('page-label').textContent = PAGES[name];
  window.scrollTo({ top: 0 });
  if (name === 'bookings') loadBookings();
}
document.querySelectorAll('[data-page]').forEach((btn) => btn.addEventListener('click', () => openPage(btn.dataset.page)));

$('filters').addEventListener('submit', (e) => {
  e.preventDefault();
  state.limit = 15;
  loadRooms();
});
$('date').addEventListener('change', () => { state.limit = 15; loadRooms(); });
// Changing the time or length needs no new request: the free periods for the day are already here.
$('start-time').addEventListener('change', () => { state.start = $('start-time').value; state.limit = 15; fillTimeOptions(); applyTime(); renderRooms(); });
$('duration').addEventListener('change', () => { state.hours = Number($('duration').value); state.limit = 15; applyTime(); renderRooms(); });
$('building').addEventListener('change', () => {
  state.building = $('building').value;
  state.limit = 15;
  renderBuildings();
  renderRooms();
});
$('available-only').addEventListener('change', () => {
  state.availableOnly = $('available-only').checked;
  state.limit = 15;
  renderRooms();
});
$('more-rooms').addEventListener('click', () => { state.limit += 15; renderRooms(); });
$('all-buildings').addEventListener('click', () => {
  state.building = '';
  $('building').value = '';
  state.limit = 15;
  renderBuildings();
  renderRooms();
});

window.addEventListener('must-change-password', () => {
  toast('Choose a new password before making a booking.');
  location.assign('/account.html#change');
});

/* ---------- Start ------------------------------------------------------------------ */

function render() {
  renderAccount();
  renderBuildings();
  renderRooms();
  renderRecords();
}

async function boot() {
  $('date').value = state.date;
  $('date').min = today;
  try {
    const { user } = await api('/auth/me');
    state.user = user;
  } catch {
    state.user = null;
  }
  await loadRooms();
  await loadBookings();
  render();
}

boot();
