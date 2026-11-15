// The approval queue: student requests waiting for the timetable office, read like an inbox.
// Keyboard: ↑/↓ (or K/J) move, A approves, R starts a rejection, Enter confirms it, Esc backs out.
import { api } from './api.js';
import { $, $$, h, longDate, showError } from './util.js';

const view = $('[data-view="approvals"]');
const list = $('[data-queue-list]', view);
const detail = $('[data-queue-detail]', view);
const live = $('[data-queue-live]', view);

const q = {
  tab: 'pending',
  items: [],
  selected: 0,
  rejecting: false,
  busy: false,
  onCountChange: null,
};

const QUICK_REASONS = [
  'The room is reserved for exams at that time',
  'Please choose a smaller room for this group',
  'Please add more detail about what the room is for',
  'Outside the times this room can be booked',
];

const CATEGORY = { study: 'Study', meeting: 'Meeting', event: 'Event', lecture: 'Lecture', tutorial: 'Tutorial', lab: 'Practical / lab', exam: 'Exam' };

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** "Tomorrow", "Today" or "Mon 17 Nov", so urgency reads at a glance. */
function when(b) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(`${b.date}T00:00:00`);
  const diff = Math.round((d - today) / 86400000);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : longDate(b.date);
  return `${day} · ${b.start_time}–${b.end_time}`;
}

const current = () => q.items[q.selected];

/* ---------- List ------------------------------------------------------------------- */

function pendingItem(b, i) {
  return h('li', {
    class: `qitem${b.ended ? ' qitem--ended' : ''}`,
    role: 'option',
    id: `req-${b.id}`,
    'aria-selected': String(i === q.selected),
    onclick: () => select(i, { focusList: true }),
  },
  h('span', { class: 'qitem__who' }, b.user_name),
  h('span', { class: 'qitem__ago mono' }, ago(b.created_at)),
  h('span', { class: 'qitem__room mono' }, b.room_code),
  h('span', { class: 'qitem__when mono' }, when(b)),
  h('span', { class: 'qitem__title' }, b.title),
  b.ended ? h('span', { class: 'tag tag--cancelled qitem__tag' }, 'time passed') : null);
}

function decidedItem(b) {
  return h('li', { class: `qitem qitem--decided qitem--${b.status}` },
    h('span', { class: 'qitem__who' }, b.user_name),
    h('span', { class: 'qitem__ago mono' }, ago(b.decided_at)),
    h('span', { class: 'qitem__room mono' }, b.room_code),
    h('span', { class: 'qitem__when mono' }, when(b)),
    h('span', { class: 'qitem__title' }, b.title),
    h('span', { class: 'qitem__decision' },
      h('span', { class: `tag tag--${b.status}` }, b.status),
      ` by ${b.decided_by_name}`,
      b.decision_reason ? h('q', {}, b.decision_reason) : null));
}

function renderList() {
  const pending = q.tab === 'pending';
  view.classList.toggle('is-decided', !pending);
  list.setAttribute('aria-label', pending ? 'Requests waiting for a decision' : 'Recent decisions');
  if (!q.items.length) {
    list.replaceChildren(h('li', { class: 'qempty' },
      pending ? 'Nothing waiting. New student requests appear here.' : 'No decisions yet.'));
    list.removeAttribute('aria-activedescendant');
  } else {
    list.replaceChildren(...q.items.map((b, i) => (pending ? pendingItem(b, i) : decidedItem(b))));
    if (pending) list.setAttribute('aria-activedescendant', `req-${current().id}`);
  }
  const waiting = pending ? q.items.length : null;
  if (waiting != null) {
    $('[data-tab-count]', view).textContent = waiting ? `· ${waiting}` : '';
    $('[data-queue-summary]', view).textContent = waiting
      ? `${waiting} request${waiting === 1 ? '' : 's'} waiting · most urgent first`
      : 'All caught up';
    q.onCountChange?.(waiting);
  } else {
    $('[data-queue-summary]', view).textContent = 'The last 100 decisions, newest first';
  }
}

/* ---------- Detail ----------------------------------------------------------------- */

function stub(b) {
  return h('div', { class: 'stub stub--queue' },
    h('p', { class: 'stub__room mono' }, b.room_code),
    h('p', { class: 'stub__name' }, `${b.room_name} · ${b.building_code} · ${b.room_capacity} seats`),
    h('div', { class: 'stub__perf', 'aria-hidden': 'true' }),
    h('p', { class: 'stub__when mono' }, `${longDate(b.date)} · ${b.start_time}–${b.end_time}`),
    h('p', { class: 'stub__meta mono' },
      `${b.attendees} of ${b.room_capacity} seats · ${CATEGORY[b.category] || b.category}${b.course_code ? ` · ${b.course_code}` : ''}`));
}

function contextBlock(b, ctx) {
  if (!ctx) return h('div', { class: 'ctx muted' }, 'Loading…');
  const others = ctx.sameRoom;
  const r = ctx.requester;
  const history = [];
  if (r.otherPending) history.push(`${r.otherPending} other request${r.otherPending === 1 ? '' : 's'} waiting`);
  if (r.decided) history.push(`${r.decided} earlier decision${r.decided === 1 ? '' : 's'}${r.rejected ? `, ${r.rejected} rejected` : ''}`);
  return h('div', { class: 'ctx' },
    h('h3', { class: 'panel__title' }, `${b.room_code} that day`),
    others.length
      ? h('ul', { class: 'ctx__list' }, others.map((o) => h('li', { class: o.status === 'pending' ? 'is-pending' : '' },
        h('span', { class: 'mono' }, `${o.start_time}–${o.end_time}`),
        ` ${o.course_code ? `${o.course_code} · ` : ''}${o.title}`,
        o.status === 'pending' ? h('span', { class: 'tag tag--pending' }, 'waiting') : null)))
      : h('p', { class: 'muted' }, `Nothing else booked in ${b.room_code} that day.`),
    h('h3', { class: 'panel__title' }, 'Requester'),
    h('p', { class: 'muted' }, history.length ? history.join(' · ') : 'First request from this person.'));
}

function actions(b) {
  if (q.rejecting) {
    const reason = h('textarea', {
      class: 'reject__reason', rows: '3', maxlength: '300', 'aria-label': 'Reason for rejecting (optional, sent to the student)',
      placeholder: 'Reason (optional): the student sees this',
    });
    reason.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); decide('rejected', reason.value); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelReject(); }
    });
    const chips = QUICK_REASONS.map((text) => h('button', {
      class: 'chip', type: 'button', onclick: () => { reason.value = text; reason.focus(); },
    }, text));
    queueMicrotask(() => reason.focus());
    return h('div', { class: 'reject' },
      h('h3', { class: 'panel__title' }, 'Reject this request'),
      h('div', { class: 'chips' }, chips),
      reason,
      h('div', { class: 'sheet__actions' },
        h('button', { class: 'button button--primary', type: 'button', onclick: () => decide('rejected', reason.value) },
          'Reject and notify ', h('kbd', {}, 'Enter')),
        h('button', { class: 'button button--secondary', type: 'button', onclick: cancelReject }, 'Back ', h('kbd', {}, 'Esc'))));
  }
  return h('div', { class: 'decide' },
    b.ended ? h('p', { class: 'decide__note' }, 'The time for this request has passed, so it can only be rejected.') : null,
    h('div', { class: 'sheet__actions' },
      h('button', {
        class: 'button button--primary', type: 'button', disabled: b.ended, onclick: () => decide('approved'),
      }, 'Approve ', h('kbd', {}, 'A')),
      h('button', { class: 'button button--secondary', type: 'button', onclick: startReject }, 'Reject… ', h('kbd', {}, 'R'))));
}

function renderDetail() {
  const b = current();
  if (q.tab !== 'pending' || !b) {
    detail.replaceChildren(q.tab === 'pending' ? h('p', { class: 'qempty' }, 'When a student requests a room, the details appear here.') : '');
    return;
  }
  detail.replaceChildren(
    h('div', { class: 'requester' },
      h('p', { class: 'requester__name serif' }, b.user_name),
      h('p', { class: 'requester__meta mono' },
        [b.user_email, b.user_department, b.user_index_number && `Index ${b.user_index_number}`].filter(Boolean).join(' · ')),
      h('p', { class: 'requester__ago' }, `Asked ${ago(b.created_at)}`)),
    stub(b),
    h('div', { class: 'purpose' },
      h('h3', { class: 'panel__title' }, 'What it is for'),
      h('p', { class: 'purpose__title' }, b.title),
      b.notes ? h('p', { class: 'purpose__notes' }, b.notes) : null),
    contextBlock(b, b.ctx),
    actions(b),
  );
  if (!b.ctx) loadContext(b);
}

async function loadContext(b) {
  try {
    b.ctx = await api(`/admin/bookings/${b.id}/context`);
    if (current() === b) renderDetail();
  } catch {
    b.ctx = { sameRoom: [], requester: { otherPending: 0, decided: 0, rejected: 0 } };
  }
}

/* ---------- Actions ---------------------------------------------------------------- */

function select(i, { focusList = false } = {}) {
  if (!q.items.length) return;
  q.selected = Math.max(0, Math.min(q.items.length - 1, i));
  q.rejecting = false;
  for (const [n, li] of $$('.qitem', list).entries()) li.setAttribute('aria-selected', String(n === q.selected));
  list.setAttribute('aria-activedescendant', `req-${current().id}`);
  $(`#req-${current().id}`)?.scrollIntoView({ block: 'nearest' });
  renderDetail();
  if (focusList) list.focus({ preventScroll: true });
  // On narrow screens the detail sits below the list.
  if (focusList && matchMedia('(max-width: 960px)').matches) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startReject() {
  if (!current()) return;
  q.rejecting = true;
  renderDetail();
}

function cancelReject() {
  q.rejecting = false;
  renderDetail();
  list.focus({ preventScroll: true });
}

async function decide(decision, reason) {
  const b = current();
  if (!b || q.busy) return;
  if (decision === 'approved' && b.ended) return;
  q.busy = true;
  showError(view, '');
  try {
    const path = `/admin/bookings/${b.id}/${decision === 'approved' ? 'approve' : 'reject'}`;
    await api(path, { method: 'POST', body: decision === 'rejected' ? { reason } : {} });
    q.items.splice(q.selected, 1);
    q.selected = Math.min(q.selected, q.items.length - 1);
    q.rejecting = false;
    live.textContent = `${decision === 'approved' ? 'Approved' : 'Rejected'} ${b.room_code} for ${b.user_name}. `
      + (q.items.length ? `${q.items.length} left.` : 'Nothing left waiting.');
    renderList();
    renderDetail();
    list.focus({ preventScroll: true });
  } catch (err) {
    showError(view, err.message);
    if (err.status === 409) await load(); // decided elsewhere, or the time passed: refresh the queue
  } finally {
    q.busy = false;
  }
}

/* ---------- Loading, tabs, keyboard ------------------------------------------------- */

async function load() {
  try {
    const { bookings } = await api(`/admin/bookings?status=${q.tab}`);
    const keep = current()?.id;
    q.items = bookings;
    const idx = q.items.findIndex((b) => b.id === keep);
    q.selected = idx >= 0 ? idx : 0;
    renderList();
    renderDetail();
  } catch (err) {
    showError(view, err.message);
  }
}

function setTab(tab) {
  q.tab = tab;
  q.selected = 0;
  q.rejecting = false;
  for (const t of $$('[data-queue-tab]', view)) t.setAttribute('aria-selected', String(t.dataset.queueTab === tab));
  load();
}

function onKey(e) {
  if (view.hidden || q.tab !== 'pending' || $('[data-sheet]').open) return;
  if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 'arrowdown' || key === 'j') { e.preventDefault(); select(q.selected + 1, { focusList: true }); }
  else if (key === 'arrowup' || key === 'k') { e.preventDefault(); select(q.selected - 1, { focusList: true }); }
  else if (key === 'a' && !q.rejecting) { e.preventDefault(); decide('approved'); }
  else if (key === 'r' && !q.rejecting) { e.preventDefault(); startReject(); }
}

/** Shows the queue. onCountChange(n) keeps the nav badge in step. */
export function showApprovals({ onCountChange }) {
  q.onCountChange = onCountChange;
  load();
}

/** Number of requests waiting, for the nav badge. */
export async function pendingCount() {
  const { bookings } = await api('/admin/bookings?status=pending');
  return bookings.length;
}

for (const t of $$('[data-queue-tab]', view)) t.addEventListener('click', () => setTab(t.dataset.queueTab));
document.addEventListener('keydown', onKey);
