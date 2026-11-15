// The approval queue, read like an inbox. Three tabs:
//   Rooms          student room requests
//   Staff access   people asking for lecturer or admin access, with their offer or appointment letter
//   Decided        recent decisions of both kinds
// Keyboard: ↑/↓ (or K/J) move, A approves, R starts a rejection, Enter confirms it, Esc backs out.
import { api } from './api.js';
import { $, $$, h, longDate, showError } from './util.js';
import { ROLE_LABEL } from './access-form.js';

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
  counts: { bookings: 0, access: 0 },
  onCountChange: null,
};

const ROOM_REASONS = [
  'The room is reserved for exams at that time',
  'Please choose a smaller room for this group',
  'Please add more detail about what the room is for',
  'Outside the times this room can be booked',
];
const ACCESS_REASONS = [
  'The letter could not be verified with Human Resources',
  'Please upload a clearer copy of the signed letter',
  'The staff ID does not match the letter',
  'Admin access is only for timetable office staff',
];
// What an admin should confirm before granting staff access.
const ACCESS_CHECKS = [
  'The name on the letter matches this account',
  'The letter is on university letterhead and signed',
  'The position and staff ID match the access asked for',
];

const CATEGORY = { study: 'Study', meeting: 'Meeting', event: 'Event', lecture: 'Lecture', tutorial: 'Tutorial', lab: 'Practical / lab', exam: 'Exam' };

const isQueue = () => q.tab === 'pending' || q.tab === 'access';
const current = () => q.items[q.selected];
const itemId = (x) => `${x.kind}-${x.id}`;

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function size(n) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "Tomorrow", "Today" or "Mon 17 Nov", so urgency reads at a glance. */
function when(b) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(`${b.date}T00:00:00`);
  const diff = Math.round((d - today) / 86400000);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : longDate(b.date);
  return `${day} · ${b.start_time}–${b.end_time}`;
}

/* ---------- List ------------------------------------------------------------------- */

function option(x, i, ...children) {
  return h('li', {
    class: `qitem${x.ended ? ' qitem--ended' : ''}`,
    role: 'option',
    id: itemId(x),
    'aria-selected': String(i === q.selected),
    onclick: () => select(i, { focusList: true }),
  }, ...children);
}

function bookingItem(b, i) {
  return option(b, i,
    h('span', { class: 'qitem__who' }, b.user_name),
    h('span', { class: 'qitem__ago mono' }, ago(b.created_at)),
    h('span', { class: 'qitem__room mono' }, b.room_code),
    h('span', { class: 'qitem__when mono' }, when(b)),
    h('span', { class: 'qitem__title' }, b.title),
    b.ended ? h('span', { class: 'tag tag--cancelled qitem__tag' }, 'time passed') : null);
}

function accessItem(r, i) {
  return option(r, i,
    h('span', { class: 'qitem__who' }, r.user_name),
    h('span', { class: 'qitem__ago mono' }, ago(r.created_at)),
    h('span', { class: `qitem__room mono qitem__role qitem__role--${r.role}` }, ROLE_LABEL[r.role]),
    h('span', { class: 'qitem__when mono' }, r.staff_id),
    h('span', { class: 'qitem__title' }, `${r.position}${r.department ? ` · ${r.department}` : ''}`));
}

function decidedItem(x) {
  const isAccess = x.kind === 'access';
  return h('li', { class: `qitem qitem--decided qitem--${x.status}` },
    h('span', { class: 'qitem__who' }, x.user_name),
    h('span', { class: 'qitem__ago mono' }, ago(x.decided_at)),
    h('span', { class: 'qitem__room mono' }, isAccess ? 'Staff access' : x.room_code),
    h('span', { class: 'qitem__when mono' }, isAccess ? ROLE_LABEL[x.role] : when(x)),
    h('span', { class: 'qitem__title' }, isAccess ? `${x.position} · ${x.staff_id}` : x.title),
    h('span', { class: 'qitem__decision' },
      h('span', { class: `tag tag--${x.status}` }, x.status),
      ` by ${x.decided_by_name}`,
      x.decision_reason ? h('q', {}, x.decision_reason) : null));
}

function renderCounts() {
  const { bookings, access } = q.counts;
  $('[data-tab-count]', view).textContent = bookings ? `· ${bookings}` : '';
  $('[data-tab-count-access]', view).textContent = access ? `· ${access}` : '';
  q.onCountChange?.(bookings + access);
}

function renderList() {
  view.classList.toggle('is-decided', !isQueue());
  const empty = {
    pending: 'No room requests waiting. New student requests appear here.',
    access: 'No staff access requests waiting.',
    decided: 'No decisions yet.',
  }[q.tab];
  list.setAttribute('aria-label', { pending: 'Room requests waiting', access: 'Staff access requests waiting', decided: 'Recent decisions' }[q.tab]);
  if (!q.items.length) {
    list.replaceChildren(h('li', { class: 'qempty' }, empty));
    list.removeAttribute('aria-activedescendant');
  } else {
    const draw = { pending: bookingItem, access: accessItem, decided: decidedItem }[q.tab];
    list.replaceChildren(...q.items.map((x, i) => draw(x, i)));
    if (isQueue()) list.setAttribute('aria-activedescendant', itemId(current()));
  }
  const n = q.items.length;
  $('[data-queue-summary]', view).textContent = {
    pending: n ? `${n} room request${n === 1 ? '' : 's'} waiting · most urgent first` : 'All room requests decided',
    access: n ? `${n} staff access request${n === 1 ? '' : 's'} waiting · oldest first` : 'No staff access requests waiting',
    decided: 'Recent decisions, newest first',
  }[q.tab];
  renderCounts();
}

/* ---------- Detail: room requests --------------------------------------------------- */

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
  const r = ctx.requester;
  const history = [];
  if (r.otherPending) history.push(`${r.otherPending} other request${r.otherPending === 1 ? '' : 's'} waiting`);
  if (r.decided) history.push(`${r.decided} earlier decision${r.decided === 1 ? '' : 's'}${r.rejected ? `, ${r.rejected} rejected` : ''}`);
  return h('div', { class: 'ctx' },
    h('h3', { class: 'panel__title' }, `${b.room_code} that day`),
    ctx.sameRoom.length
      ? h('ul', { class: 'ctx__list' }, ctx.sameRoom.map((o) => h('li', {},
        h('span', { class: 'mono' }, `${o.start_time}–${o.end_time}`),
        ` ${o.course_code ? `${o.course_code} · ` : ''}${o.title}`,
        o.status === 'pending' ? h('span', { class: 'tag tag--pending' }, 'waiting') : null)))
      : h('p', { class: 'muted' }, `Nothing else booked in ${b.room_code} that day.`),
    h('h3', { class: 'panel__title' }, 'Requester'),
    h('p', { class: 'muted' }, history.length ? history.join(' · ') : 'First request from this person.'));
}

function bookingDetail(b) {
  if (!b.ctx) loadContext(b);
  return [
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
  ];
}

async function loadContext(b) {
  try {
    b.ctx = await api(`/admin/bookings/${b.id}/context`);
  } catch {
    b.ctx = { sameRoom: [], requester: { otherPending: 0, decided: 0, rejected: 0 } };
  }
  if (current() === b) renderDetail();
}

/* ---------- Detail: staff access ----------------------------------------------------- */

const checksDone = (r) => r.checks?.size === ACCESS_CHECKS.length;

function accessDetail(r) {
  r.checks ??= new Set();
  const url = `/api/admin/access-requests/${r.id}/document`;
  const isImage = r.document_type.startsWith('image/');
  const fact = (label, value, mono = false) => h('div', { class: 'fact' },
    h('dt', {}, label), h('dd', { class: mono ? 'mono' : null }, value));

  const checklist = h('fieldset', { class: 'checklist' },
    h('legend', { class: 'panel__title' }, 'Before approving, confirm'),
    ACCESS_CHECKS.map((text, i) => {
      const box = h('input', { type: 'checkbox', checked: r.checks.has(i) });
      box.addEventListener('change', () => {
        if (box.checked) r.checks.add(i); else r.checks.delete(i);
        const approve = $('[data-approve]', detail);
        if (approve) approve.disabled = !checksDone(r);
      });
      return h('label', { class: 'check check--block' }, box, h('span', {}, text));
    }));

  return [
    h('div', { class: 'requester' },
      h('p', { class: 'requester__name serif' }, r.user_name),
      h('p', { class: 'requester__meta mono' }, r.user_email),
      h('p', { class: 'requester__ago' },
        `Asked ${ago(r.created_at)} · account ${r.user_created_at ? `opened ${ago(r.user_created_at)}` : ''} · now a ${r.user_role}`)),
    h('div', { class: `asks asks--${r.role}` },
      h('span', { class: 'panel__title' }, 'Asks for'),
      h('span', { class: 'asks__role serif' }, ROLE_LABEL[r.role])),
    h('dl', { class: 'facts' },
      fact('Staff ID', r.staff_id, true),
      fact('Position', r.position),
      fact('Department', r.department || '—'),
      r.note ? fact('Note', r.note) : null),
    h('div', { class: 'letter' },
      h('h3', { class: 'panel__title' }, 'Offer or appointment letter'),
      isImage
        ? h('a', { href: url, target: '_blank', rel: 'noopener', class: 'letter__preview' },
          h('img', { src: url, alt: `Letter uploaded by ${r.user_name}`, loading: 'lazy' }))
        : null,
      h('a', { class: 'button button--secondary letter__open', href: url, target: '_blank', rel: 'noopener' },
        `Open the letter (${r.document_type === 'application/pdf' ? 'PDF' : 'image'} · ${size(r.document_size)}) ↗`),
      h('p', { class: 'letter__meta mono', title: r.document_sha256 },
        `${r.document_name} · SHA-256 ${r.document_sha256.slice(0, 12)}…${r.document_sha256.slice(-6)}`),
      h('p', { class: 'field__hint' }, 'The letter is deleted as soon as you decide. Its fingerprint stays in the audit log.')),
    checklist,
  ];
}

/* ---------- Detail: actions ------------------------------------------------------------ */

function actions(x) {
  const access = x.kind === 'access';
  if (q.rejecting) {
    const reason = h('textarea', {
      class: 'reject__reason', rows: '3', maxlength: '300', 'aria-label': 'Reason for rejecting (optional, sent to the person)',
      placeholder: 'Reason (optional): they see this',
    });
    reason.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); decide('rejected', reason.value); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelReject(); }
    });
    queueMicrotask(() => reason.focus());
    return h('div', { class: 'reject' },
      h('h3', { class: 'panel__title' }, access ? 'Reject this access request' : 'Reject this request'),
      h('div', { class: 'chips' }, (access ? ACCESS_REASONS : ROOM_REASONS).map((text) => h('button', {
        class: 'chip', type: 'button', onclick: () => { reason.value = text; reason.focus(); },
      }, text))),
      reason,
      h('div', { class: 'sheet__actions' },
        h('button', { class: 'button button--primary', type: 'button', onclick: () => decide('rejected', reason.value) },
          'Reject and notify ', h('kbd', {}, 'Enter')),
        h('button', { class: 'button button--secondary', type: 'button', onclick: cancelReject }, 'Back ', h('kbd', {}, 'Esc'))));
  }
  const blocked = access ? !checksDone(x) : x.ended;
  return h('div', { class: 'decide' },
    !access && x.ended ? h('p', { class: 'decide__note' }, 'The time for this request has passed, so it can only be rejected.') : null,
    h('div', { class: 'sheet__actions' },
      h('button', {
        class: 'button button--primary', type: 'button', disabled: blocked, 'data-approve': '', onclick: () => decide('approved'),
      }, access ? `Approve ${x.role === 'admin' ? 'admin' : 'lecturer'} access ` : 'Approve ', h('kbd', {}, 'A')),
      h('button', { class: 'button button--secondary', type: 'button', onclick: startReject }, 'Reject… ', h('kbd', {}, 'R'))));
}

function renderDetail() {
  const x = current();
  if (!isQueue() || !x) {
    detail.replaceChildren(isQueue()
      ? h('p', { class: 'qempty' }, q.tab === 'access'
        ? 'When someone asks for lecturer or admin access, their letter appears here.'
        : 'When a student requests a room, the details appear here.')
      : '');
    return;
  }
  detail.replaceChildren(...(x.kind === 'access' ? accessDetail(x) : bookingDetail(x)), actions(x));
}

/* ---------- Actions ---------------------------------------------------------------- */

function select(i, { focusList = false } = {}) {
  if (!q.items.length) return;
  q.selected = Math.max(0, Math.min(q.items.length - 1, i));
  q.rejecting = false;
  for (const [n, li] of $$('.qitem', list).entries()) li.setAttribute('aria-selected', String(n === q.selected));
  list.setAttribute('aria-activedescendant', itemId(current()));
  $(`#${itemId(current())}`)?.scrollIntoView({ block: 'nearest' });
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
  const x = current();
  if (!x || q.busy) return;
  const access = x.kind === 'access';
  if (decision === 'approved' && (access ? !checksDone(x) : x.ended)) {
    if (access) {
      live.textContent = 'Tick all three checks before approving.';
      $('.checklist input:not(:checked)', detail)?.focus();
    }
    return;
  }
  q.busy = true;
  showError(view, '');
  try {
    const base = access ? `/admin/access-requests/${x.id}` : `/admin/bookings/${x.id}`;
    await api(`${base}/${decision === 'approved' ? 'approve' : 'reject'}`, { method: 'POST', body: decision === 'rejected' ? { reason } : {} });
    q.items.splice(q.selected, 1);
    q.selected = Math.min(q.selected, q.items.length - 1);
    q.rejecting = false;
    q.counts[access ? 'access' : 'bookings'] = q.items.length;
    const what = access ? `${ROLE_LABEL[x.role].toLowerCase()} access` : x.room_code;
    live.textContent = `${decision === 'approved' ? 'Approved' : 'Rejected'} ${what} for ${x.user_name}. `
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

async function fetchItems(tab) {
  if (tab === 'pending') {
    const { bookings } = await api('/admin/bookings?status=pending');
    return bookings.map((b) => ({ ...b, kind: 'booking' }));
  }
  if (tab === 'access') {
    const { requests } = await api('/admin/access-requests?status=pending');
    return requests.map((r) => ({ ...r, kind: 'access' }));
  }
  const [b, a] = await Promise.all([api('/admin/bookings?status=decided'), api('/admin/access-requests?status=decided')]);
  return [...b.bookings.map((x) => ({ ...x, kind: 'booking' })), ...a.requests.map((x) => ({ ...x, kind: 'access' }))]
    .sort((x, y) => new Date(y.decided_at) - new Date(x.decided_at));
}

async function load() {
  try {
    const [items, counts] = await Promise.all([fetchItems(q.tab), api('/admin/pending-counts')]);
    const keep = current() && itemId(current());
    // Keep ticked checks when the same request is still there after a refresh.
    const old = new Map(q.items.map((x) => [itemId(x), x]));
    q.items = items.map((x) => (old.get(itemId(x))?.checks ? { ...x, checks: old.get(itemId(x)).checks } : x));
    q.counts = counts;
    const idx = q.items.findIndex((x) => itemId(x) === keep);
    q.selected = idx >= 0 ? idx : 0;
    renderList();
    renderDetail();
  } catch (err) {
    showError(view, err.message);
  }
}

function setTab(tab) {
  q.tab = tab;
  q.items = [];
  q.selected = 0;
  q.rejecting = false;
  for (const t of $$('[data-queue-tab]', view)) t.setAttribute('aria-selected', String(t.dataset.queueTab === tab));
  // Clear at once, so the previous tab's requests never show under the new tab's name.
  view.classList.toggle('is-decided', !isQueue());
  list.replaceChildren(h('li', { class: 'qempty' }, 'Loading…'));
  detail.replaceChildren();
  load();
}

function onKey(e) {
  if (view.hidden || !isQueue() || $('[data-sheet]')?.open || $('[data-edit-sheet]')?.open) return;
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

/** Everything waiting (room requests and staff access), for the nav badge. */
export async function pendingCount() {
  const { bookings, access } = await api('/admin/pending-counts');
  return bookings + access;
}

for (const t of $$('[data-queue-tab]', view)) t.addEventListener('click', () => setTab(t.dataset.queueTab));
document.addEventListener('keydown', onKey);
