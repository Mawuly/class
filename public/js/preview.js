// Standalone browser demo. No API calls, account impersonation or production data changes.
const $ = (id) => document.getElementById(id);
const buildings = [
  { code: 'SW', name: 'Sandwich Lecture Theatre', count: 23 },
  { code: 'NLT', name: 'New Lecture Theatre', count: 23 },
  { code: 'CALC', name: 'C. A. Ackah Theatre', count: 13 },
];
const rooms = buildings.flatMap(b => Array.from({ length: b.count }, (_, i) => ({ code: `${b.code}-${String(i + 1).padStart(2, '0')}`, building: b.code, name: b.name, capacity: 30 })));
const key = 'ucc-spaces-preview-v2';
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
function initial() {
  return {
    accounts: [],
    session: null,
    settings: { open: '06:30', close: '20:30', maxHours: 3 },
    bookings: [],
    blocks: [{ id: 'sample-maintenance', room: 'SW-03', date: tomorrow, start: '10:00', end: '12:00', reason: 'Sample maintenance closure' }],
  };
}
let state;
try {
  state = JSON.parse(localStorage.getItem(key));
  if (!state || !Array.isArray(state.bookings) || !Array.isArray(state.blocks)) state = initial();
  if (!Array.isArray(state.accounts)) state.accounts = [];
  state.settings = { ...initial().settings, ...(state.settings || {}) };
  if (!state.accounts.some(a => a.id === state.session)) state.session = null;
} catch { state = initial(); }
function save() { try { localStorage.setItem(key, JSON.stringify(state)); } catch { toast('Browser storage is unavailable. Changes last only until refresh.'); } }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function button(text, cls, fn) { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
const holds = b => ['pending', 'approved'].includes(b.status);
const overlaps = (a, b) => a.date === b.date && a.start < b.end && a.end > b.start;
const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const toTime = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const currentUser = () => state.accounts.find(a => a.id === state.session) || null;
const mine = () => state.bookings.filter(b => b.userId === currentUser()?.id);
const cleanEmail = v => String(v).trim().toLowerCase();
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
function passwordProblem(v) {
  if (String(v).length < 8) return 'Use at least 8 characters.';
  if (!/[a-z]/i.test(v)) return 'Include at least one letter.';
  if (!/\d/.test(v)) return 'Include at least one number.';
  return '';
}
function validate(s, { wholeHours = false, maxMinutes = 360 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !s.start || !s.end) return 'Choose a date, start time and end time.';
  if (s.date < today) return 'Choose today or a future date.';
  if (s.date === today && s.start < new Date().toISOString().slice(11, 16)) return 'Choose a start time that has not passed.';
  if (s.start >= s.end) return 'End time must be after start time.';
  if (s.start < state.settings.open || s.end > state.settings.close) return `Classes run between ${clock(state.settings.open)} and ${clock(state.settings.close)}.`;
  if (![s.start, s.end].every(t => /:(00|30)$/.test(t))) return 'Use half-hour slots, such as 7:30 AM or 9:00 AM.';
  const minutes = toMin(s.end) - toMin(s.start);
  if (minutes > maxMinutes) return `Choose a period of up to ${Math.round(maxMinutes / 60)} hours.`;
  if (wholeHours && minutes % 60) return 'Durations are whole hours, such as 1, 2 or 3 hours.';
  return '';
}
function clock(t) {
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}
function conflicts(room, s) {
  return state.blocks.some(b => b.room === room && overlaps(b, s))
    || state.bookings.some(b => b.room === room && holds(b) && overlaps(b, s));
}
/** A stable, room-specific starting point so the day's available periods are not all identical. */
function seedNumber(room, date) {
  let h = 2166136261;
  for (const ch of `${room}|${date}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}
/** The first free whole-hour period on that date, searched from the room's seeded start. */
function freePeriod(room, date) {
  const seed = seedNumber(room, date);
  const { open, close, maxHours } = state.settings;
  const hours = 1 + (seed % Math.max(1, maxHours));
  const span = hours * 60;
  const first = toMin(open), last = toMin(close) - span;
  if (last < first) return null;
  const slots = Math.floor((last - first) / 30) + 1;
  const start0 = first + (Math.floor(seed / 7) % slots) * 30;
  const candidates = [];
  for (let m = start0; m <= last; m += 30) candidates.push(m);
  for (let m = first; m < start0; m += 30) candidates.push(m);
  for (const m of candidates) {
    const s = { date, start: toTime(m), end: toTime(m + span) };
    if (!conflicts(room, s)) return { ...s, hours };
  }
  return null;
}
function status(room, s) {
  if (state.blocks.some(b => b.room === room && overlaps(b, s))) return 'unavailable';
  const found = state.bookings.find(b => b.room === room && holds(b) && overlaps(b, s));
  return found?.status || 'available';
}
function badge(s) { return el('span', `status ${s}`, ({ approved: 'Booked', pending: 'Pending approval', available: 'Available', unavailable: 'Unavailable', rejected: 'Rejected', cancelled: 'Cancelled' })[s]); }
function renderBuildings() {
  $('buildings').replaceChildren(...buildings.map(b => {
    const c = button('', `building-card${$('building').value === b.code ? ' active' : ''}`, () => { $('building').value = b.code; render(); $('room-search').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    c.setAttribute('aria-pressed', String($('building').value === b.code));
    const art = el('div', `building-visual ${b.code.toLowerCase()}`); art.append(el('span', 'building-code', b.code));
    const info = el('div', 'building-info'); const sub = el('p'); sub.append(el('span', '', `${b.count} classrooms`), el('span', '', 'Explore →'));
    info.append(el('h3', '', b.name), sub); c.append(art, info); return c;
  }));
}

/* ---------- Accounts (this browser only) ------------------------------------------------ */

let pendingAction = null;

function requireAccount(action) {
  if (currentUser()) return true;
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

function finishAuth(message) {
  save(); render(); $('auth-dialog').close();
  const next = pendingAction; pendingAction = null;
  if (message) toast(message);
  if (next) next();
}

async function digest(text) {
  if (globalThis.crypto?.subtle) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let hash = 5381;
  for (const ch of text) hash = ((hash * 33) ^ (ch.codePointAt(0) || 0)) >>> 0;
  return `fallback-${hash.toString(16)}`;
}

function salt() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function renderAccount() {
  const box = $('account-actions'); const user = currentUser();
  box.replaceChildren();
  if (user) {
    box.append(el('span', 'account-name', user.name), button('Sign out', 'text-button', signOut));
  } else {
    box.append(button('Sign in', 'text-button', () => openAuth('login')), button('Create account', 'primary', () => openAuth('register')));
  }
}

function signOut() {
  state.session = null; save(); renderAccount();
  if (!$('discover-page').hidden) { render(); } else { openPage('discover'); }
  toast('Signed out.');
}

$('auth-login').addEventListener('submit', async e => {
  e.preventDefault();
  const email = cleanEmail($('login-email').value), password = $('login-password').value;
  const account = state.accounts.find(a => a.email === email);
  if (!account) { $('auth-error').textContent = 'No account uses that email on this browser.'; return; }
  if (await digest(`${account.salt}:${password}`) !== account.hash) { $('auth-error').textContent = 'That password is not correct.'; return; }
  state.session = account.id;
  e.target.reset();
  finishAuth(`Signed in as ${account.name}.`);
});

$('auth-register').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('reg-name').value.trim(), email = cleanEmail($('reg-email').value);
  const password = $('reg-password').value, problem = passwordProblem(password);
  if (name.length < 2) { $('auth-error').textContent = 'Enter your full name.'; return; }
  if (!validEmail(email)) { $('auth-error').textContent = 'Enter a valid email address.'; return; }
  if (state.accounts.some(a => a.email === email)) { $('auth-error').textContent = 'An account already uses that email. Sign in instead.'; return; }
  if (problem) { $('auth-error').textContent = problem; return; }
  if (password !== $('reg-confirm').value) { $('auth-error').textContent = 'Passwords do not match.'; return; }
  const accountSalt = salt();
  const account = { id: crypto.randomUUID(), name, email, salt: accountSalt, hash: await digest(`${accountSalt}:${password}`), created: Date.now() };
  state.accounts.push(account); state.session = account.id;
  e.target.reset();
  finishAuth('Account created.');
});

$('auth-forgot').addEventListener('submit', e => {
  e.preventDefault();
  const email = cleanEmail($('forgot-email').value);
  const account = state.accounts.find(a => a.email === email);
  if (!account) { $('auth-error').textContent = 'No account uses that email on this browser.'; return; }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  account.reset = { code, expires: Date.now() + 10 * 60 * 1000, attempts: 0 };
  save();
  $('reset-email').value = email;
  showAuthView('reset');
  $('auth-note').textContent = `Preview code: ${code}. No email service is connected here, so the code is shown on screen.`;
});

$('auth-reset').addEventListener('submit', async e => {
  e.preventDefault();
  const email = cleanEmail($('reset-email').value);
  const account = state.accounts.find(a => a.email === email);
  const code = $('reset-code').value.trim(), password = $('reset-password').value;
  if (!account?.reset) { $('auth-error').textContent = 'Ask for a new reset code.'; return; }
  if (Date.now() > account.reset.expires) { $('auth-error').textContent = 'That code has expired. Ask for a new one.'; return; }
  if (account.reset.attempts >= 5) { $('auth-error').textContent = 'Too many attempts. Ask for a new code.'; return; }
  if (account.reset.code !== code) { account.reset.attempts += 1; save(); $('auth-error').textContent = 'That code is not correct.'; return; }
  const problem = passwordProblem(password);
  if (problem) { $('auth-error').textContent = problem; return; }
  if (password !== $('reset-confirm').value) { $('auth-error').textContent = 'Passwords do not match.'; return; }
  account.salt = salt();
  account.hash = await digest(`${account.salt}:${password}`);
  delete account.reset;
  state.session = account.id;
  e.target.reset();
  finishAuth('Password reset.');
});

document.querySelectorAll('[data-auth-view]').forEach(b => b.addEventListener('click', () => showAuthView(b.dataset.authView)));
$('close-auth').addEventListener('click', closeAuth);

/* ---------- Rooms ----------------------------------------------------------------------- */

let selectedRoom, selectedSlot, roomLimit = 15, adminFilter = 'pending';
function dayLabel(date) { return new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }
function requestRoom(room, period) {
  if (!requireAccount(() => requestRoom(room, period))) return;
  if (!period || conflicts(room.code, period)) { $('search-error').textContent = `${room.code} is no longer free at that time.`; render(); return; }
  selectedRoom = room; selectedSlot = { ...period };
  $('booking-title').textContent = `Request ${room.code}`;
  $('booking-slot').textContent = `${room.name} · ${dayLabel(period.date)} · ${clock(period.start)} – ${clock(period.end)}`;
  $('booking-note').textContent = 'Approval required.';
  $('booking-error').textContent = ''; $('purpose').value = ''; $('course-code').value = ''; $('supervisor').value = '';
  $('booking-dialog').showModal(); $('purpose').focus();
}
function renderRooms() {
  const date = $('date').value;
  const error = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today ? '' : 'Choose today or a future date.';
  $('search-error').textContent = error;
  const items = error ? [] : rooms
    .filter(r => !$('building').value || r.building === $('building').value)
    .map(r => ({ room: r, period: freePeriod(r.code, date) }));
  const free = items.filter(x => x.period).length;
  $('free-stat').textContent = error ? '—' : `${free} of ${items.length}`;
  const shown = items.filter(x => !$('available-only').checked || x.period);
  $('result-count').textContent = `${shown.length} of ${items.length} rooms${$('building').value ? ` in ${$('building').value}` : ' across all theatres'}`;
  const visible = shown.slice(0, roomLimit);
  $('rooms').replaceChildren(...visible.map(({ room: r, period }) => {
    const card = el('article', 'room-card'), top = el('div', 'room-top');
    top.append(el('h3', '', r.code), el('span', `status ${period ? 'available' : 'unavailable'}`, period ? 'Available' : 'Fully booked'));
    card.append(top, el('p', '', r.name), el('p', 'room-detail', 'Lecture room'));
    card.append(el('p', 'room-when', period
      ? `${clock(period.start)} – ${clock(period.end)} · ${dayLabel(date)}`
      : `No availability · ${dayLabel(date)}`));
    const btn = button(period ? 'Request this room' : 'Fully booked', '', () => requestRoom(r, period)); btn.disabled = !period; card.append(btn); return card;
  }));
  const more = $('more-rooms');
  more.hidden = shown.length <= roomLimit;
  more.textContent = `Show more rooms (${Math.min(roomLimit + 15, shown.length)} of ${shown.length})`;
  if (!shown.length) $('rooms').append(el('p', 'empty', error ? 'Choose a date to see free classrooms.' : 'No rooms match this selection. Try another theatre.'));
}
function record(b, admin) {
  const card = el('article', 'record'), copy = el('div'), actions = el('div', 'record-actions');
  const extra = [b.courseCode, b.supervisor].filter(Boolean).join(' · ');
  copy.append(el('h3', '', `${b.room} · ${b.purpose}`), el('p', '', `${b.date} · ${clock(b.start)} – ${clock(b.end)}${extra ? ` · ${extra}` : ''}`));
  if (admin) copy.append(el('p', 'record-meta', `Requested by ${state.accounts.find(a => a.id === b.userId)?.name || 'Preview account'}`));
  actions.append(badge(b.status));
  if (admin && b.status === 'pending') {
    actions.append(button('Approve', 'primary', () => { b.status = 'approved'; save(); render(); toast(`${b.room} booking approved.`); }), button('Reject', 'text-button', () => { b.status = 'rejected'; save(); render(); toast('Request rejected. The slot is now free.'); }));
  } else if (!admin && holds(b)) actions.append(button('Cancel', 'text-button', () => { b.status = 'cancelled'; save(); render(); toast('Booking cancelled.'); }));
  card.append(copy, actions); return card;
}
function renderRecords() {
  const my = mine();
  $('booking-count').textContent = my.filter(holds).length;
  $('my-bookings').replaceChildren(...my.map(b => record(b, false)));
  if (!my.length) $('my-bookings').append(el('p', 'empty', currentUser() ? 'No bookings yet.' : 'Sign in to see your bookings.'));
  const counts = { pending: 0, approved: 0, rejected: 0, all: state.bookings.length };
  for (const b of state.bookings) if (b.status in counts) counts[b.status] += 1;
  for (const key of ['pending', 'approved', 'rejected', 'all']) $(`tab-${key}`).textContent = counts[key];
  $('admin-summary').textContent = `${counts.pending} pending · ${state.blocks.length} closure${state.blocks.length === 1 ? '' : 's'}`;
  const list = adminFilter === 'all' ? state.bookings : state.bookings.filter(b => b.status === adminFilter);
  $('admin-bookings').replaceChildren(...list.map(b => record(b, true)));
  $('requests-count').textContent = `${list.length}`;
  if (!list.length) $('admin-bookings').append(el('p', 'empty', adminFilter === 'all' ? 'No requests yet.' : `No ${adminFilter} requests.`));
  $('blocks').replaceChildren(...state.blocks.map(b => {
    const c = el('article', 'record'), copy = el('div'); copy.append(el('h3', '', `${b.room} · ${b.reason}`), el('p', '', `${b.date} · ${clock(b.start)} – ${clock(b.end)}`));
    c.append(copy, button('Make available', 'text-button', () => { state.blocks = state.blocks.filter(x => x.id !== b.id); save(); render(); toast('Unavailable period removed.'); })); return c;
  }));
}
function render() { renderAccount(); renderBuildings(); renderRooms(); renderRecords(); }

/* ---------- Pages ----------------------------------------------------------------------- */

const PAGES = { discover: 'Find a classroom', bookings: 'My bookings', admin: 'Timetable office' };
function openPage(name) {
  for (const n of Object.keys(PAGES)) $(`${n}-page`).hidden = n !== name;
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('selected', b.dataset.page === name));
  $('page-label').textContent = PAGES[name];
  window.scrollTo({ top: 0 }); renderRecords();
}
document.querySelectorAll('[data-page]').forEach(btn => btn.addEventListener('click', () => {
  const target = btn.dataset.page;
  if (target !== 'discover' && !requireAccount(() => openPage(target))) return;
  openPage(target);
}));
document.querySelectorAll('[data-admin-tab]').forEach(tab => tab.addEventListener('click', () => {
  adminFilter = tab.dataset.adminTab;
  document.querySelectorAll('[data-admin-tab]').forEach(x => x.classList.toggle('selected', x === tab));
  renderRecords();
}));

/* ---------- Booking and closures -------------------------------------------------------- */

$('date').value = tomorrow; $('date').min = today; $('block-date').value = tomorrow; $('block-date').min = today;
$('block-room').replaceChildren(...rooms.map(r => { const o = el('option', '', r.code); o.value = r.code; return o; }));
$('filters').addEventListener('submit', e => { e.preventDefault(); roomLimit = 15; render(); });
['date', 'building', 'available-only'].forEach(id => $(id).addEventListener('change', () => { roomLimit = 15; render(); }));
$('more-rooms').addEventListener('click', () => { roomLimit += 15; renderRooms(); });
$('all-buildings').addEventListener('click', () => { $('building').value = ''; render(); });
$('close-dialog').addEventListener('click', () => $('booking-dialog').close());
$('booking-form').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireAccount(() => $('booking-form').requestSubmit())) return;
  const s = selectedSlot; let error = validate(s, { wholeHours: true, maxMinutes: state.settings.maxHours * 60 });
  if (!error && conflicts(selectedRoom.code, s)) error = 'This room is no longer available at that time.';
  if (!error && mine().some(b => holds(b) && overlaps(b, s))) error = 'You already have a booking or request at this time.';
  const purpose = $('purpose').value.trim();
  const courseCode = $('course-code').value.trim().toUpperCase();
  const supervisor = $('supervisor').value.trim();
  if (!error && !purpose) error = 'Enter the course or activity.';
  $('booking-error').textContent = error; if (error) return;
  state.bookings.unshift({ id: crypto.randomUUID(), userId: currentUser().id, room: selectedRoom.code, ...s, purpose, courseCode, supervisor, status: 'pending' });
  save(); render(); $('booking-dialog').close(); toast('Request sent. Awaiting approval.');
});
$('block-form').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireAccount(() => $('block-form').requestSubmit())) return;
  const b = { room: $('block-room').value, date: $('block-date').value, start: $('block-start').value, end: $('block-end').value, reason: $('block-reason').value.trim() };
  let error = validate(b, { maxMinutes: 24 * 60 }); if (!error && b.reason.length < 3) error = 'Give a reason of at least 3 characters.';
  if (!error && status(b.room, b) !== 'available') error = 'This period overlaps a booking or another closure.';
  $('block-error').textContent = error; if (error) return;
  state.blocks.push({ id: crypto.randomUUID(), ...b }); save(); render(); toast(`${b.room} marked unavailable for the selected period.`);
});
$('reset-demo').addEventListener('click', () => {
  if (!confirm('Clear all preview bookings and closures on this browser? Accounts are kept.')) return;
  state.bookings = []; state.blocks = initial().blocks; save(); render(); toast('Preview data cleared.');
});
function fillSettings() {
  $('set-open').value = state.settings.open;
  $('set-close').value = state.settings.close;
  $('set-max').value = String(state.settings.maxHours);
}
$('settings-form').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireAccount(() => $('settings-form').requestSubmit())) return;
  const open = $('set-open').value, close = $('set-close').value, maxHours = Number($('set-max').value);
  let error = '';
  if (!open || !close) error = 'Set the opening and closing times.';
  else if (open >= close) error = 'Closing time must be after opening time.';
  else if (![open, close].every(t => /:(00|30)$/.test(t))) error = 'Use half-hour times, such as 6:30 AM.';
  else if (toMin(close) - toMin(open) < 60) error = 'Leave at least one hour in the day.';
  $('settings-error').textContent = error; if (error) return;
  state.settings = { open, close, maxHours };
  save(); fillSettings(); render(); toast('Booking window updated.');
});
window.addEventListener('storage', e => {
  if (e.key !== key) return;
  try {
    const next = JSON.parse(e.newValue);
    if (!next || !Array.isArray(next.bookings) || !Array.isArray(next.blocks)) return;
    state = next;
    if (!Array.isArray(state.accounts)) state.accounts = [];
    state.settings = { ...initial().settings, ...(state.settings || {}) };
    if (!state.accounts.some(a => a.id === state.session)) {
      state.session = null;
      if (!$('discover-page').hidden) openPage('discover');
    }
    fillSettings();
    render();
  } catch {}
});
fillSettings();
render();
