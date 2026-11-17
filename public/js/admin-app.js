// The timetable office portal (/admin): its own sign-in, request for access, and the admin pages.
// Students and lecturers use the main site (/); admins can use both.
import { api } from './api.js';
import { $, $$, h, showError } from './util.js';
import { showApprovals, pendingCount } from './approvals.js';
import { showRooms } from './rooms-admin.js';
import { showPeople } from './people-admin.js';
import { showStats } from './stats.js';
import { showAudit } from './audit.js';
import { showSettings } from './settings-admin.js';
import { showTimetable } from './timetable-admin.js';
import { staffFields } from './access-form.js';
import { openEditSheet, closeEditSheet } from './edit-sheet.js';
import { startPasswordToggles } from './password-toggle.js';

const PAGES = ['approvals', 'rooms', 'people', 'stats', 'audit', 'timetable', 'settings'];
const VIEWS = ['portal-landing', 'not-admin', ...PAGES];
const state = { user: null, meta: null, badgeTimer: null, staff: null };

/* ---------- Clock ------------------------------------------------------------------ */

function tickClock() {
  const now = new Date();
  const day = now.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase();
  const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toUpperCase();
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  $('[data-clock]').textContent = `${day} ${date} · ${time}`;
}

function show(view) {
  for (const v of VIEWS) $(`[data-view="${v}"]`).hidden = v !== view;
}

/* ---------- Signed out ------------------------------------------------------------- */

function showLanding(form = 'login') {
  state.user = null;
  clearInterval(state.badgeTimer);
  $('[data-signed-in]').hidden = true;
  document.body.classList.remove('has-sidebar');
  show('portal-landing');
  for (const f of $$('[data-view="portal-landing"] form')) f.hidden = f.dataset.form !== `portal-${form}`;
  $(`[data-form="portal-${form}"] input`)?.focus();
}

async function submitLogin(form) {
  showError(form, '');
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const { user } = await api('/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    form.reset();
    await enter(user);
  } catch (err) {
    showError(form, err.message);
  } finally {
    button.disabled = false;
  }
}

/** New staff: create the account, then send the letter for timetable office access. */
async function submitApply(form) {
  showError(form, '');
  const problem = state.staff.validate();
  if (problem) { showError(form, problem); return; }
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const fd = new FormData(form);
    const { user } = await api('/auth/register', {
      method: 'POST', body: { name: fd.get('name'), email: fd.get('email'), password: fd.get('password') },
    });
    let sendError = null;
    try { await state.staff.send('admin'); } catch (err) { sendError = err.message; }
    form.reset();
    state.staff = staffFields({ roles: ['admin'] });
    $('[data-portal-staff]').replaceChildren(state.staff.el);
    await enter(user, { sendError });
  } catch (err) {
    showError(form, err.message);
  } finally {
    button.disabled = false;
  }
}

/* ---------- Signed in, not an admin ------------------------------------------------- */

function since(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return mins < 2 ? 'just now' : `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} days ago`;
}

function openRequestSheet() {
  const fields = staffFields({ roles: ['admin'], department: state.user.department || '' });
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
    try {
      await fields.send('admin');
      closeEditSheet();
      await showNotAdmin();
    } catch (err) {
      showError(form, err.message);
    } finally {
      submit.disabled = false;
    }
  });
  openEditSheet('Request timetable office access', form);
}

async function showNotAdmin({ sendError = null } = {}) {
  show('not-admin');
  const box = $('[data-portal-status]');
  const ask = (label) => h('button', { class: 'link-button', type: 'button', onclick: openRequestSheet }, label);
  if (state.user.mustChangePassword) {
    box.replaceChildren(h('p', {}, 'You signed in with a temporary password. Choose your own on the main site first, then come back.'));
    return;
  }
  if (sendError) {
    box.replaceChildren(h('p', { class: 'alert' }, `Your account was created, but your letter was not sent: ${sendError}`),
      h('p', {}, ask('Send it again')));
    return;
  }
  const { request } = await api('/access-requests/mine').catch(() => ({ request: null }));
  const lines = [];
  if (request?.status === 'pending' && request.role === 'admin') {
    lines.push(h('p', { class: 'portal-status__pending' }, h('b', {}, 'Your request for timetable office access is being checked'),
      ` by an existing admin. Sent ${since(request.created_at)} · ${request.document_name}.`),
    h('p', {}, `Until then you have ${state.user.role} access on the main site.`));
  } else if (request?.status === 'rejected' && request.role === 'admin') {
    lines.push(h('p', {}, `Your request for timetable office access was not approved.${request.decision_reason ? ` Reason: ${request.decision_reason}` : ''}`),
      h('p', {}, ask('Send a new request')));
  } else {
    lines.push(h('p', {}, `${state.user.name}, your account is a ${state.user.role} account. Students and lecturers book rooms on the main site.`),
      h('p', {}, 'Work in the timetable office? ', ask('Request timetable office access'), ' with your offer or appointment letter.'));
  }
  box.replaceChildren(...lines);
}

/* ---------- Admins ---------------------------------------------------------------- */

function setPendingBadge(n) {
  const badge = $('[data-pending-badge]');
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = !n;
  $('[data-nav="approvals"]').setAttribute('aria-label', n ? `Approvals, ${n} waiting` : 'Approvals');
}

async function refreshBadge() {
  try { setPendingBadge(await pendingCount()); } catch { /* keep the last count */ }
}

async function route() {
  if (state.user?.role !== 'admin') return;
  const page = PAGES.find((p) => location.hash === `#/${p}`) || 'approvals';
  show(page);
  for (const a of $$('[data-nav]')) a.toggleAttribute('aria-current', a.dataset.nav === page);
  if (page === 'approvals') showApprovals({ onCountChange: setPendingBadge });
  if (page === 'rooms') showRooms({ onChange: async () => { state.meta = await api('/rooms/meta'); } });
  if (page === 'people') showPeople({ me: state.user });
  if (page === 'stats') showStats({ buildings: state.meta.buildings });
  if (page === 'audit') showAudit();
  if (page === 'settings') showSettings();
  if (page === 'timetable') showTimetable();
}

async function enter(user, opts = {}) {
  state.user = user;
  $('[data-signed-in]').hidden = user.role !== 'admin';
  // Admins get the menu as a sidebar on the left (admin-sidebar.css).
  document.body.classList.toggle('has-sidebar', user.role === 'admin');
  $('[data-user-name]').textContent = `${user.name} · ${user.role}`;
  if (user.role !== 'admin' || user.mustChangePassword) { await showNotAdmin(opts); return; }
  state.meta = await api('/rooms/meta');
  refreshBadge();
  clearInterval(state.badgeTimer);
  state.badgeTimer = setInterval(refreshBadge, 60_000);
  await route();
}

async function signOut() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLanding();
}

/* ---------- Start ----------------------------------------------------------------- */

function init() {
  startPasswordToggles();
  tickClock();
  setInterval(tickClock, 1000);
  state.staff = staffFields({ roles: ['admin'] });
  $('[data-portal-staff]').replaceChildren(state.staff.el);
  $('[data-form="portal-login"]').addEventListener('submit', (e) => { e.preventDefault(); submitLogin(e.target); });
  $('[data-form="portal-apply"]').addEventListener('submit', (e) => { e.preventDefault(); submitApply(e.target); });
  for (const b of $$('[data-portal-switch]')) b.addEventListener('click', () => showLanding(b.dataset.portalSwitch));
  for (const b of $$('[data-sign-out]')) b.addEventListener('click', signOut);
  window.addEventListener('hashchange', route);
  // The server says a new password is needed (an admin reset this account while it was open).
  window.addEventListener('must-change-password', () => { if (state.user) { state.user.mustChangePassword = true; showNotAdmin(); } });
  api('/auth/me').then(({ user }) => enter(user)).catch(() => showLanding());
}

init();
