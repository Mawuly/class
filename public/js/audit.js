// The audit log, for admins: what happened, who did it, when, and from where.
// The sentences come from the server, so the page and the CSV export always agree.
import { api } from './api.js';
import { $, h, isoDate, addDays, showError } from './util.js';

const view = $('[data-view="audit"]');
const list = $('[data-audit]', view);
const more = $('[data-audit-more]', view);

const a = { group: 'all', q: '', from: '', to: '', entries: [], nextBefore: null, seq: 0, timer: null };

// Above this many failed sign-ins in 24 hours the panel warns that someone may be guessing.
const WARN_FAILED = 5;

function query(extra = {}) {
  const q = new URLSearchParams();
  if (a.group !== 'all') q.set('group', a.group);
  if (a.q) q.set('q', a.q);
  if (a.from) q.set('from', a.from);
  if (a.to) q.set('to', a.to);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}

const KIND = (action) => {
  if (action === 'auth.login_failed') return 'failed';
  if (/^(auth|user|access)\./.test(action)) return 'security';
  if (/^(booking|series)\./.test(action)) return 'booking';
  return 'room';
};

function renderSecurity(s) {
  const box = $('[data-security]', view);
  const warn = s.failed_24h >= WARN_FAILED;
  box.className = `security${warn ? ' security--warn' : ''}`;
  box.replaceChildren(
    h('p', {}, warn ? h('b', {}, `${s.failed_24h} failed sign-ins in the last 24 hours`) : 'Last 24 hours: ',
      warn
        ? ` from ${s.failed_ips_24h} address${s.failed_ips_24h === 1 ? '' : 'es'}, trying ${s.failed_emails_24h} email${s.failed_emails_24h === 1 ? '' : 's'}. Someone may be guessing passwords. `
        : `${s.logins_24h} sign-in${s.logins_24h === 1 ? '' : 's'} · ${s.failed_24h} failed sign-in${s.failed_24h === 1 ? '' : 's'}`
          + `${s.failed_24h ? ` from ${s.failed_ips_24h} address${s.failed_ips_24h === 1 ? '' : 'es'}` : ''}. `),
    s.failed_24h ? h('button', { class: 'link-button', type: 'button', onclick: () => setGroup('failed') }, 'Show failed sign-ins') : null);
}

function row(e) {
  const at = new Date(e.created_at);
  return h('li', { class: `entry entry--${KIND(e.action)}` },
    h('time', { class: 'entry__time mono', datetime: e.created_at, title: at.toLocaleString('en-GB') },
      at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })),
    h('div', { class: 'entry__what' },
      h('p', { class: 'entry__summary' }, KIND(e.action) === 'failed' ? h('span', { 'aria-hidden': 'true' }, '⚠ ') : null, e.summary),
      e.detail ? h('p', { class: 'entry__detail' }, e.detail) : null),
    h('div', { class: 'entry__meta mono' },
      h('span', {}, e.action),
      e.ip ? h('span', { title: 'IP address' }, e.ip) : null,
      e.actor?.role ? h('span', {}, e.actor.role) : null));
}

function render() {
  if (!a.entries.length) {
    list.replaceChildren(h('p', { class: 'stat-empty' }, 'Nothing matches these filters.'));
  } else {
    // Group by day (local), newest first.
    const days = new Map();
    for (const e of a.entries) {
      const key = isoDate(new Date(e.created_at));
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(e);
    }
    const today = isoDate(new Date());
    list.replaceChildren(...[...days].map(([key, entries]) => h('section', { class: 'audit-day', 'aria-label': key },
      h('h2', { class: 'audit-day__head mono' },
        key === today ? 'Today' : key === addDays(today, -1) ? 'Yesterday'
          : new Date(`${key}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
        h('span', {}, `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)),
      h('ol', { class: 'entries' }, entries.map(row)))));
  }
  more.hidden = !a.nextBefore;
  $('[data-audit-csv]', view).href = `/api/admin/audit.csv?${query()}`;
}

async function load({ append = false } = {}) {
  const seq = ++a.seq;
  showError(view, '');
  list.classList.add('is-loading');
  try {
    const data = await api(`/admin/audit?${query(append && a.nextBefore ? { before: a.nextBefore } : {})}`);
    if (seq !== a.seq) return;
    a.entries = append ? a.entries.concat(data.entries) : data.entries;
    a.nextBefore = data.nextBefore;
    renderSecurity(data.security);
    render();
  } catch (err) {
    showError(view, err.message);
  } finally {
    if (seq === a.seq) list.classList.remove('is-loading');
  }
}

function setGroup(group) {
  a.group = group;
  $('[data-audit-group]', view).value = group;
  load();
}

export function showAudit() {
  load();
}

$('[data-audit-group]', view).addEventListener('change', (e) => setGroup(e.target.value));
$('[data-audit-q]', view).addEventListener('input', (e) => {
  a.q = e.target.value.trim();
  clearTimeout(a.timer);
  a.timer = setTimeout(() => load(), 250);
});
for (const key of ['from', 'to']) {
  $(`[data-audit-${key}]`, view).addEventListener('change', (e) => { a[key] = e.target.value; load(); });
}
more.addEventListener('click', async () => {
  more.disabled = true;
  await load({ append: true });
  more.disabled = false;
});
