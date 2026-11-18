// The Profile page on the main site: your details, signing in and security, lecturer access,
// a summary of your bookings, and your calendar.
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
const ROLE = { student: 'Student', lecturer: 'Lecturer', admin: 'Timetable office' };
const field = (label, input, hint) => el('label', { class: 'pf-field' }, label, input, hint ? el('small', { class: 'pf-hint' }, hint) : '');
const message = () => el('p', { class: 'pf-message', role: 'status' });
const say = (box, text, ok = true) => { box.textContent = text; box.classList.toggle('pf-message--error', !ok); };
const initials = (name) => name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

let ctx = { toast: () => {}, onUserChange: () => {} };

/* ---------- My details ------------------------------------------------------------- */

function detailsCard(u) {
  const name = el('input', { name: 'name', value: u.name, minlength: '2', maxlength: '80', autocomplete: 'name', required: true });
  const department = el('input', { name: 'department', value: u.department || '', maxlength: '80', autocomplete: 'organization-title' });
  const index = el('input', { name: 'indexNumber', value: u.indexNumber || '', maxlength: '30', autocomplete: 'off' });
  const msg = message();
  const form = el('form', { class: 'pf-form', novalidate: true },
    field('Full name', name),
    el('div', { class: 'pf-row' },
      field('Department', department),
      u.role === 'student' ? field('Index number', index) : ''),
    el('div', { class: 'pf-row pf-row--fixed' },
      field('Email', el('input', { value: u.email, disabled: true }), 'You sign in with this, so it can’t be changed here.'),
      field('Role', el('input', { value: ROLE[u.role] || u.role, disabled: true }), u.role === 'student' ? 'Lecturers: request lecturer access below.' : 'Roles are set by the timetable office.')),
    el('div', { class: 'pf-actions' }, el('button', { class: 'primary', type: 'submit' }, 'Save details'), msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const { user } = await api('/auth/profile', { method: 'PATCH', body: { name: name.value, department: department.value, ...(u.role === 'student' ? { indexNumber: index.value } : {}) } });
      say(msg, 'Saved.');
      ctx.onUserChange(user);
      $('pf-name').textContent = user.name;
      $('pf-avatar').textContent = initials(user.name);
    } catch (err) { say(msg, err.message, false); } finally { button.disabled = false; }
  });
  return el('section', { class: 'pf-card' }, el('h2', {}, 'My details'), form);
}

/* ---------- Signing in and security -------------------------------------------------- */

function passwordForm(u) {
  const current = el('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = el('input', { type: 'password', autocomplete: 'new-password', minlength: '8', required: true });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password', minlength: '8', required: true });
  const msg = message();
  const form = el('form', { class: 'pf-form', novalidate: true },
    el('h3', {}, u.hasPassword ? 'Change password' : 'Set a password'),
    u.hasPassword ? '' : el('p', { class: 'pf-note' }, 'You sign in with Google. Set a password too if you also want to sign in with your email.'),
    u.hasPassword ? field('Current password', current) : '',
    el('div', { class: 'pf-row' }, field('New password', next), field('Confirm new password', confirm)),
    el('small', { class: 'pf-hint' }, 'At least 8 characters, with a letter and a number.'),
    el('div', { class: 'pf-actions' }, el('button', { class: 'primary', type: 'submit' }, u.hasPassword ? 'Change password' : 'Set password'), msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (next.value !== confirm.value) { say(msg, 'The new passwords don’t match.', false); return; }
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } });
      form.reset();
      ctx.toast(u.hasPassword ? 'Password changed. Your other devices are signed out.' : 'Password set. You can now also sign in with your email.');
      await showProfile();
    } catch (err) { say(msg, err.message, false); } finally { button.disabled = false; }
  });
  return form;
}

function phoneBlock(u) {
  const box = el('div', { class: 'pf-form' }, el('h3', {}, 'Phone for reset codes'));
  const msg = message();
  if (u.phone) {
    const remove = el('button', { class: 'text-button', type: 'button' }, 'Remove');
    remove.addEventListener('click', async () => {
      if (!window.confirm('Remove this phone number? Reset codes will then come by email.')) return;
      try { await api('/auth/phone', { method: 'DELETE' }); await showProfile(); } catch (err) { say(msg, err.message, false); }
    });
    box.append(el('p', { class: 'pf-note' }, el('strong', {}, u.phone), ' · confirmed. Password-reset codes are texted here.'), el('div', { class: 'pf-actions' }, remove, msg));
    return box;
  }
  const number = el('input', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '024 123 4567' });
  const code = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '7', placeholder: '123 456' });
  const codeRow = el('div', { class: 'pf-row', hidden: true }, field('Code we texted you', code));
  const send = el('button', { class: 'primary', type: 'button' }, 'Text me a code');
  const check = el('button', { class: 'primary', type: 'button', hidden: true }, 'Confirm number');
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      await api('/auth/phone', { method: 'POST', body: { phone: number.value } });
      codeRow.hidden = false; check.hidden = false; send.textContent = 'Send again';
      say(msg, 'We texted you a 6-digit code. It works for 10 minutes.');
      code.focus();
    } catch (err) { say(msg, err.message, false); } finally { send.disabled = false; }
  });
  check.addEventListener('click', async () => {
    check.disabled = true;
    try {
      await api('/auth/phone/verify', { method: 'POST', body: { code: code.value } });
      ctx.toast('Phone number confirmed.');
      await showProfile();
    } catch (err) { say(msg, err.message, false); check.disabled = false; }
  });
  box.append(el('p', { class: 'pf-note' }, 'Add a Ghana mobile number to get password-reset codes by text.'),
    field('Mobile number', number), codeRow, el('div', { class: 'pf-actions' }, send, check, msg));
  return box;
}

function securityCard(u) {
  const others = el('button', { class: 'text-button', type: 'button' }, 'Sign out on all other devices');
  const msg = message();
  others.addEventListener('click', async () => {
    try {
      await api('/auth/sign-out-others', { method: 'POST' });
      say(msg, 'Done. Every other device has to sign in again.');
    } catch (err) { say(msg, err.message, false); }
  });
  return el('section', { class: 'pf-card' },
    el('h2', {}, 'Signing in and security'),
    el('ul', { class: 'pf-facts' },
      el('li', {}, el('span', {}, 'Google'), el('strong', {}, u.googleLinked ? 'Linked: you can use “Continue with Google”' : 'Not linked')),
      el('li', {}, el('span', {}, 'Password'), el('strong', {}, u.hasPassword ? 'Set' : 'Not set (Google only)'))),
    passwordForm(u),
    phoneBlock(u),
    el('div', { class: 'pf-form' }, el('h3', {}, 'Devices'),
      el('p', { class: 'pf-note' }, 'Signed in on a lab or friend’s computer and forgot to sign out? This signs out everywhere except here.'),
      el('div', { class: 'pf-actions' }, others, msg)));
}

/* ---------- Lecturer access (students) ------------------------------------------------- */

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('The file could not be read'));
    reader.readAsDataURL(file);
  });
}

function accessCard(u, request) {
  if (u.role !== 'student') return '';
  const card = el('section', { class: 'pf-card' }, el('h2', {}, 'Lecturer access'));
  if (request?.status === 'pending') {
    card.append(el('p', { class: 'pf-note pf-note--pending' }, 'Your request for ', el('strong', {}, `${request.role === 'admin' ? 'timetable office' : 'lecturer'} access`),
      ` is waiting for the timetable office. Sent ${new Date(request.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} with ${request.document_name}.`));
    return card;
  }
  if (request?.status === 'rejected') {
    card.append(el('p', { class: 'pf-note' }, `Your last request was not approved${request.decision_reason ? `: “${request.decision_reason}”` : '.'} You can send a new one.`));
  }
  const staffId = el('input', { maxlength: '30', placeholder: 'e.g. UCC/STF/1234', required: true });
  const position = el('input', { maxlength: '80', placeholder: 'e.g. Lecturer, Department of Management', required: true });
  const dept = el('input', { maxlength: '80', value: u.department || '' });
  const file = el('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png', required: true });
  const msg = message();
  const form = el('form', { class: 'pf-form', novalidate: true },
    el('p', { class: 'pf-note' }, 'Teaching at UCC? Send your offer or appointment letter. The timetable office checks it and then gives you lecturer access; the letter is deleted after the decision.'),
    el('div', { class: 'pf-row' }, field('Staff ID', staffId), field('Position', position)),
    el('div', { class: 'pf-row' }, field('Department', dept), field('Offer or appointment letter (PDF, JPG or PNG, up to 3 MB)', file)),
    el('div', { class: 'pf-actions' }, el('button', { class: 'primary', type: 'submit' }, 'Send for checking'), msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = file.files[0];
    if (!staffId.value.trim() || !position.value.trim()) { say(msg, 'Fill in your staff ID and position.', false); return; }
    if (!f) { say(msg, 'Attach your offer or appointment letter.', false); return; }
    if (f.size > 3 * 1024 * 1024) { say(msg, 'The letter must be 3 MB or smaller.', false); return; }
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      await api('/access-requests', { method: 'POST', body: {
        role: 'lecturer', staffId: staffId.value, position: position.value, department: dept.value,
        document: { name: f.name, type: f.type, data: await toBase64(f) },
      } });
      ctx.toast('Sent. The timetable office will check your letter.');
      await showProfile();
    } catch (err) { say(msg, err.message, false); button.disabled = false; }
  });
  card.append(form);
  return card;
}

/* ---------- Activity and calendar ------------------------------------------------------ */

function activityCard(a) {
  const tile = (value, label) => el('div', { class: 'pf-tile' }, el('strong', {}, String(value)), el('span', {}, label));
  const rate = a.checked_in + a.released ? Math.round((a.checked_in / (a.checked_in + a.released)) * 100) : null;
  return el('section', { class: 'pf-card' },
    el('h2', {}, 'My activity'),
    el('p', { class: 'pf-note' }, `Your own bookings over the last ${a.sinceDays} days and still to come.`),
    el('div', { class: 'pf-tiles' },
      tile(a.upcoming, 'coming up'), tile(a.bookings, 'bookings'), tile(`${a.hours} h`, 'booked'),
      tile(a.checked_in, 'checked in'), tile(a.released, 'released (no-show)')),
    rate != null ? el('p', { class: 'pf-note' }, `You checked in to ${rate}% of the bookings that needed it.${a.released ? ' A booking nobody checks in to within 15 minutes is released for others.' : ''}`) : '');
}

function calendarCard(status) {
  const box = el('div', { class: 'pf-form' });
  const msg = message();
  const draw = (links) => {
    box.replaceChildren(
      el('p', { class: 'pf-note' }, 'Download your bookings once, or subscribe so your calendar app stays up to date.'),
      el('div', { class: 'pf-actions' },
        el('a', { class: 'primary pf-link-button', href: '/api/bookings/mine.ics', download: '' }, 'Download (.ics)'),
        links ? '' : el('button', { class: 'text-button', type: 'button', onclick: create }, status.hasFeed ? 'Make a new subscription link' : 'Get a subscription link')),
      links ? el('div', { class: 'pf-links' },
        el('p', { class: 'pf-note' }, 'Your private link (shown once; anyone with it can see your bookings):'),
        el('input', { value: links.url, readonly: true, onclick: (e) => e.target.select() }),
        el('div', { class: 'pf-actions' },
          el('a', { class: 'text-button', href: links.google, target: '_blank', rel: 'noopener' }, 'Add to Google Calendar'),
          el('a', { class: 'text-button', href: links.outlook, target: '_blank', rel: 'noopener' }, 'Add to Outlook'),
          el('a', { class: 'text-button', href: links.webcal }, 'Apple Calendar'))) : '',
      status.hasFeed && !links ? el('div', { class: 'pf-actions' },
        el('span', { class: 'pf-note' }, 'A subscription link is active.'),
        el('button', { class: 'text-button', type: 'button', onclick: removeLink }, 'Turn it off')) : '',
      msg);
  };
  async function create() {
    try { draw(await api('/calendar/feed', { method: 'POST' })); status.hasFeed = true; } catch (err) { say(msg, err.message, false); }
  }
  async function removeLink() {
    try { await api('/calendar/feed', { method: 'DELETE' }); status.hasFeed = false; draw(null); say(msg, 'Turned off. The old link stops working.'); } catch (err) { say(msg, err.message, false); }
  }
  draw(null);
  return el('section', { class: 'pf-card' }, el('h2', {}, 'Calendar'), box);
}

/* ---------- Page -------------------------------------------------------------------- */

export async function showProfile(options) {
  if (options) ctx = { ...ctx, ...options };
  const root = $('profile-page');
  root.replaceChildren(el('p', { class: 'pf-note' }, 'Loading your profile…'));
  try {
    const [{ user, activity }, access, calendar] = await Promise.all([
      api('/auth/profile'),
      api('/access-requests/mine').catch(() => ({ request: null })),
      api('/calendar/status').catch(() => ({ hasFeed: false })),
    ]);
    root.replaceChildren(
      el('header', { class: 'pf-head' },
        el('span', { class: 'pf-avatar', id: 'pf-avatar', 'aria-hidden': 'true' }, initials(user.name)),
        el('div', {},
          el('h1', { id: 'pf-name' }, user.name),
          el('p', { class: 'secondary' }, `${ROLE[user.role] || user.role} · ${user.email}${user.createdAt ? ` · member since ${new Date(user.createdAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}` : ''}`))),
      el('div', { class: 'pf-grid' },
        el('div', { class: 'pf-col' }, detailsCard(user), activityCard(activity), calendarCard(calendar)),
        el('div', { class: 'pf-col' }, securityCard(user), accessCard(user, access.request))));
  } catch (err) {
    root.replaceChildren(el('p', { class: 'error' }, err.message));
  }
}
