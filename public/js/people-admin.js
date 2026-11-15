// People (admins): find anyone, change their role, correct details, deactivate accounts.
import { api } from './api.js';
import { $, h, showError } from './util.js';
import { openEditSheet, closeEditSheet } from './edit-sheet.js';

const view = $('[data-view="people"]');
const table = $('[data-people-table]', view);

const ROLES = {
  student: { label: 'Student', hint: 'Can request study, seminar and meeting rooms; requests wait for approval' },
  lecturer: { label: 'Lecturer', hint: 'Bookings confirmed straight away; can book lecture halls and labs' },
  admin: { label: 'Admin', hint: 'Approves requests and manages rooms and people' },
};

const p = { q: '', role: '', status: 'active', data: null, me: null, timer: null };

function ago(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  if (days < 45) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ---------- Table ------------------------------------------------------------------ */

function row(u) {
  const you = u.id === p.me.id;
  return h('div', { class: `rt-row pt-row${u.is_active ? '' : ' rt-row--inactive'}`, role: 'row' },
    h('span', { class: 'pt-person', role: 'cell' },
      h('span', { class: 'pt-name' }, u.name, you ? h('span', { class: 'tag tag--pending' }, 'you') : null,
        u.is_active ? null : h('span', { class: 'tag tag--cancelled' }, 'inactive'),
        u.reset_requested_at ? h('span', { class: 'tag tag--approved', title: `Asked ${ago(u.reset_requested_at)}` }, 'forgot password') : null,
        u.must_change_password && !u.reset_requested_at ? h('span', { class: 'tag tag--pending' }, 'temporary password') : null),
      h('span', { class: 'pt-email mono' }, u.email)),
    h('span', { class: `pt-role pt-role--${u.role}`, role: 'cell' }, ROLES[u.role].label),
    // Empty cells show "—" on wide screens and disappear on phones (see app.css).
    h('span', { class: 'pt-dept', role: 'cell' }, u.department || ''),
    h('span', { class: 'pt-index mono', role: 'cell' }, u.index_number || ''),
    h('span', { class: 'rt-up mono', role: 'cell', title: 'Upcoming bookings' }, u.upcoming || ''),
    u.last_login
      ? h('span', { class: 'pt-seen', role: 'cell' }, ago(u.last_login))
      : h('span', { class: 'pt-seen pt-seen--never', role: 'cell' }, 'Never signed in'),
    h('span', { class: 'rt-act', role: 'cell' },
      h('button', { class: 'link-button', type: 'button', 'aria-label': `Edit ${u.name}`, onclick: () => openPerson(u) }, 'Edit')));
}

function render() {
  const { users, counts } = p.data;
  const parts = [`${counts.active} people`, `${counts.students} student${counts.students === 1 ? '' : 's'}`,
    `${counts.lecturers} lecturer${counts.lecturers === 1 ? '' : 's'}`, `${counts.admins} admin${counts.admins === 1 ? '' : 's'}`];
  if (counts.inactive) parts.push(`${counts.inactive} inactive`);
  $('[data-people-summary]', view).textContent = parts.join(' · ');

  const head = h('div', { class: 'rt-row rt-row--head pt-row', role: 'row' },
    ...['Person', 'Role', 'Department', 'Index no.', 'Upcoming', 'Last signed in', ''].map((t) => h('span', { role: 'columnheader' }, t)));
  table.replaceChildren(h('div', { role: 'table', 'aria-label': 'People' }, head,
    users.length ? h('div', { role: 'rowgroup' }, users.map(row)) : h('p', { class: 'rt-empty' }, 'Nobody matches.')));
}

async function load() {
  showError(view, '');
  try {
    const q = new URLSearchParams({ q: p.q, role: p.role, status: p.status });
    p.data = await api(`/admin/users?${q}`);
    render();
  } catch (err) {
    showError(view, err.message);
  }
}

/* ---------- Editor ----------------------------------------------------------------- */

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), input,
    hint ? h('span', { class: 'field__hint' }, hint) : null);
}

function openPerson(u) {
  const you = u.id === p.me.id;
  const locked = you || (u.role === 'admin' && u.in_admin_emails);
  const name = h('input', { maxlength: '80', value: u.name });
  const department = h('input', { maxlength: '80', value: u.department || '' });
  const indexNumber = h('input', { class: 'mono', maxlength: '30', value: u.index_number || '' });

  const roleGroup = h('fieldset', { class: 'radios' },
    h('legend', { class: 'field__label' }, 'Role'),
    ...Object.entries(ROLES).map(([value, r]) => h('label', { class: 'radio' },
      h('input', { type: 'radio', name: 'role', value, checked: u.role === value, disabled: locked }),
      h('span', {}, h('b', {}, r.label), h('small', {}, r.hint)))));

  const notes = [];
  if (you) notes.push('This is you. Another admin has to change your role or deactivate your account.');
  else if (locked) notes.push('Listed in ADMIN_EMAILS in Vercel, so always an admin. Remove the address there to change the role.');

  const errors = h('p', { class: 'alert', 'data-error': '', hidden: true });
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'requester' },
      h('p', { class: 'requester__name serif' }, u.name),
      h('p', { class: 'requester__meta mono' }, u.email),
      h('p', { class: 'requester__ago' },
        `Joined ${new Date(u.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
        + ` · ${u.last_login ? `last signed in ${ago(u.last_login)}` : 'never signed in'}`
        + ` · ${u.total_bookings} booking${u.total_bookings === 1 ? '' : 's'} on record`)),
    ...notes.map((n) => h('p', { class: 'decide__note' }, n)),
    roleGroup,
    field('Full name', name),
    h('div', { class: 'field-row' }, field('Department', department), field('Index number', indexNumber)),
    errors,
    h('div', { class: 'sheet__actions' },
      h('button', { class: 'button button--primary', type: 'submit' }, 'Save changes'),
      h('button', { class: 'button button--secondary', type: 'button', onclick: closeEditSheet }, 'Cancel')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(form, '');
    // Send only what changed, so a details edit never trips the role rules.
    const body = {};
    const role = form.querySelector('input[name="role"]:checked')?.value;
    if (role && role !== u.role) body.role = role;
    if (name.value.trim() !== u.name) body.name = name.value;
    if (department.value.trim() !== (u.department || '')) body.department = department.value;
    if (indexNumber.value.trim() !== (u.index_number || '')) body.indexNumber = indexNumber.value;
    if (!Object.keys(body).length) { closeEditSheet(); return; }
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
      closeEditSheet();
      await load();
    } catch (err) {
      showError(form, err.message);
    }
  });

  const confirmBox = h('div', { class: 'clash', hidden: true, role: 'alert' });
  const setActive = async (isActive, cancelUpcoming = false) => {
    showError(form, '');
    confirmBox.hidden = true;
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { isActive, cancelUpcoming } });
      closeEditSheet();
      await load();
    } catch (err) {
      if (err.status === 409 && err.data.needsConfirm) {
        confirmBox.replaceChildren(
          h('p', { class: 'clash__msg' }, err.message),
          h('button', { class: 'button button--ink', type: 'button', onclick: () => setActive(false, true) },
            `Cancel ${err.data.upcoming} booking${err.data.upcoming === 1 ? '' : 's'} and deactivate`));
        confirmBox.hidden = false;
      } else {
        showError(form, err.message);
      }
    }
  };
  const account = h('section', { class: 'danger' },
    h('h3', { class: 'panel__title' }, 'Account'),
    h('p', { class: 'danger__status' }, u.is_active
      ? `Active · ${u.upcoming} upcoming booking${u.upcoming === 1 ? '' : 's'}`
      : 'Inactive · cannot sign in; their booking history is kept'),
    confirmBox,
    you ? null : h('div', { class: 'sheet__actions' }, u.is_active
      ? h('button', { class: 'button button--secondary', type: 'button', onclick: () => setActive(false) }, 'Deactivate account')
      : h('button', { class: 'button button--secondary', type: 'button', onclick: () => setActive(true) }, 'Reactivate account')),
    h('p', { class: 'field__hint' }, 'A deactivated person is signed out at once and cannot sign in again until reactivated.'));

  openEditSheet(`Edit ${u.name}`, form, account, you ? null : passwordSection(u));
  (locked ? name : form.querySelector('input[name="role"]:checked') || name).focus();
}

/**
 * Reset password: makes a one-time temporary password, shows it once, and signs the person
 * out everywhere. Needs a second click, because it locks them out until they get the code.
 */
function passwordSection(u) {
  const out = h('div', { class: 'temp', hidden: true, role: 'status' });
  let armed = null;
  const button = h('button', { class: 'button button--secondary', type: 'button' }, 'Reset password');
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = 'Click again to reset';
      armed = setTimeout(() => { armed = null; button.textContent = 'Reset password'; }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    button.disabled = true;
    try {
      const r = await api(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
      const until = new Date(r.expiresAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const copy = h('button', { class: 'button button--ink', type: 'button' }, 'Copy');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(r.temporaryPassword); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy it'; }
      });
      out.replaceChildren(
        h('p', { class: 'temp__label' }, `Temporary password for ${u.name}`),
        h('p', { class: 'temp__code mono', 'aria-label': r.temporaryPassword.split('').join(' ') }, r.temporaryPassword),
        h('div', { class: 'temp__row' }, copy),
        h('p', { class: 'temp__hint' }, `Give it to ${u.name.split(' ')[0]} in person or by phone, after checking their ID card. `
          + `It works until ${until}, and they choose their own password when they sign in. `
          + 'It is shown only now: close this and it can’t be seen again.'),
        ...(r.isActive ? [] : [h('p', { class: 'temp__hint' }, 'This account is deactivated: reactivate it too, or they still can’t sign in.')]));
      out.hidden = false;
      button.textContent = 'Password reset';
      load();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Reset password';
      out.replaceChildren(h('p', {}, err.message));
      out.hidden = false;
    }
  });
  return h('section', { class: 'danger' },
    h('h3', { class: 'panel__title' }, 'Password'),
    u.reset_requested_at
      ? h('p', { class: 'decide__note' }, `${u.name.split(' ')[0]} said they forgot their password ${ago(u.reset_requested_at)}. Check their ID before resetting.`)
      : null,
    h('p', { class: 'danger__status' }, u.must_change_password
      ? 'Has a temporary password and hasn’t chosen their own yet.'
      : 'Forgot their password? Reset it to give them a temporary one.'),
    h('div', { class: 'sheet__actions' }, button),
    out,
    h('p', { class: 'field__hint' }, 'Resetting signs them out on every device straight away.'));
}

/* ---------- Wiring --------------------------------------------------------------------- */

/** Shows the page. me is the signed-in admin, so they can't lock themselves out. */
export function showPeople({ me }) {
  p.me = me;
  load();
}

$('[data-people-search]', view).addEventListener('input', (e) => {
  p.q = e.target.value.trim();
  clearTimeout(p.timer);
  p.timer = setTimeout(load, 250);
});
$('[data-people-role]', view).addEventListener('change', (e) => { p.role = e.target.value; load(); });
$('[data-people-status]', view).addEventListener('change', (e) => { p.status = e.target.value; load(); });
