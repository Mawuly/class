// The page the QR code on a room's door opens: /door?c=K7P2QX.
// Shows whether the room is free, checks you in to your booking, and books it from the next half hour.
import { api } from './api.js';
import { $, h, showError, toMin, fromMin } from './util.js';
import { checkIn, formatCode, checkOutButton } from './checkin.js';

const CATEGORIES = {
  lecture: 'Lecture', tutorial: 'Tutorial', lab: 'Lab', exam: 'Exam', meeting: 'Meeting', study: 'Study', event: 'Event',
};
const STUDENT_CATEGORIES = ['study', 'meeting', 'event'];

const box = $('[data-door]');
const code = (new URLSearchParams(location.search).get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
let flash = null; // a message to show once after the next load, e.g. "You're checked in"

function tickClock() {
  const now = new Date();
  $('[data-clock]').textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const duration = (start, end) => {
  const m = toMin(end) - toMin(start);
  return m % 60 ? `${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ''}${m % 60} min` : `${m / 60} h`;
};

/* ---------- Now: free, in use, waiting for check-in, closed ----------------------------- */

/** When the next booking or closure starts, if any. */
const freeUntil = (d) => [d.upcoming[0]?.start, d.closures?.[0]?.start].filter(Boolean).sort()[0] || null;

function statusCard(d) {
  const c = d.current;
  const next = d.upcoming[0];
  if (!d.isOpen) {
    return h('section', { class: 'door-status door-status--closed' },
      h('p', { class: 'door-status__word serif' }, 'Closed'),
      h('p', {}, `Rooms are open for booking ${d.open}–${d.close}.`));
  }
  if (d.closed) {
    return h('section', { class: 'door-status door-status--closed' },
      h('p', { class: 'door-status__word serif' }, 'Unavailable'),
      h('p', { class: 'mono' }, `until ${d.closed.end}`),
      h('p', {}, d.closed.reason));
  }
  if (!c) {
    return h('section', { class: 'door-status door-status--free' },
      h('p', { class: 'door-status__word serif' }, 'Free'),
      h('p', { class: 'mono' }, freeUntil(d) ? `until ${freeUntil(d)}` : `for the rest of the day (until ${d.close})`));
  }
  const what = c.title ? `${c.title}${c.courseCode ? ` · ${c.courseCode}` : ''}` : '';
  if (c.status === 'approved' && !c.checkedIn && d.checkIn.release) {
    return h('section', { class: 'door-status door-status--waiting' },
      h('p', { class: 'door-status__word serif' }, 'Booked'),
      h('p', { class: 'mono' }, `${c.start}–${c.end}${what ? ` · ${what}` : ''}`),
      h('p', {}, 'Waiting for check-in until ', h('b', { class: 'mono' }, c.checkInBy),
        '. If nobody checks in, the room becomes free.'));
  }
  return h('section', { class: 'door-status door-status--busy' },
    h('p', { class: 'door-status__word serif' }, c.status === 'pending' ? 'Requested' : 'In use'),
    h('p', { class: 'mono' }, `until ${c.end}${what ? ` · ${what}` : ''}`),
    c.checkedIn ? h('p', { class: 'muted' }, 'Checked in') : '');
}

/* ---------- Your booking here ------------------------------------------------------- */

async function doCheckIn(button) {
  button.disabled = true;
  try {
    const { booking } = await checkIn(code, 'qr');
    flash = `You're checked in. ${booking.room_code} is yours until ${booking.end_time}.`;
    await load();
  } catch (err) {
    button.disabled = false;
    showError(box, err.message);
  }
}

function mineCard(d) {
  const m = d.mine;
  if (!d.signedIn) {
    const next = encodeURIComponent(`/door?c=${code}`);
    return h('section', { class: 'door-card panel' },
      h('p', {}, 'Have a booking here? Sign in to check in. You can also book this room if it is free.'),
      h('a', { class: 'button button--primary door__big', href: `/?next=${next}` }, 'Sign in'));
  }
  if (!m) return '';
  const when = h('span', { class: 'mono' }, `${m.start}–${m.end}`);
  const head = h('p', { class: 'door-card__label mono' }, 'Your booking');
  const title = h('p', { class: 'door-card__title' }, m.title, ' · ', when);
  if (m.state === 'open') {
    const button = h('button', { class: 'button button--primary door__big', type: 'button' }, 'Check in');
    button.addEventListener('click', () => doCheckIn(button));
    return h('section', { class: 'door-card door-card--action panel' }, head, title, button,
      d.checkIn.release ? h('p', { class: 'muted' }, `Check in by ${m.deadline}, or the room is released for others.`) : '');
  }
  if (m.state === 'checked-in') {
    return h('section', { class: 'door-card door-card--done panel' }, head, title,
      h('p', { class: 'door-card__ok' }, h('span', { 'aria-hidden': 'true' }, '✓ '), `Checked in. The room is yours until ${m.end}.`),
      m.start < d.time ? checkOutButton({ id: m.id, room_code: d.room.code }, {
        cls: 'button button--secondary door__big',
        onDone: () => { flash = `Checked out. ${d.room.code} is free for others now.`; load(); },
      }) : '',
      m.start < d.time ? h('p', { class: 'muted' }, 'Leaving early? Check out so others can use the room.') : '');
  }
  if (m.state === 'early') {
    return h('section', { class: 'door-card panel' }, head, title,
      h('p', {}, 'You can check in here from ', h('b', { class: 'mono' }, m.opensAt), '. Scan the code again then.'));
  }
  if (m.state === 'released') {
    return h('section', { class: 'door-card door-card--lost panel' }, head, title,
      h('p', {}, `This booking was released because nobody checked in by ${m.deadline}.`),
      d.book ? h('p', { class: 'muted' }, 'If the room is free, you can book it again below.') : '');
  }
  if (m.state === 'not-approved') {
    return h('section', { class: 'door-card panel' }, head, title,
      h('p', {}, 'Your request is waiting for the timetable office to approve it.'));
  }
  return '';
}

/* ---------- Book it from the next half hour ------------------------------------------ */

function bookCard(d) {
  const b = d.book;
  if (!b || d.mine?.state === 'open' || d.mine?.state === 'checked-in') return '';
  const cats = b.needsApproval ? STUDENT_CATEGORIES : Object.keys(CATEGORIES);
  const end = h('select', { name: 'end', 'aria-label': 'Until' },
    b.ends.map((e, i) => h('option', { value: e, selected: i === Math.min(1, b.ends.length - 1) }, `${e} (${duration(b.start, e)})`)));
  const submit = h('button', { class: 'button button--primary', type: 'submit' }, b.needsApproval ? 'Send request' : 'Book');
  const form = h('form', { class: 'form door-book panel', novalidate: true },
    h('h2', { class: 'panel__title' }, `Book ${d.room.code} from ${b.start}`),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Until'), end),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'What for'),
      h('input', { name: 'title', required: true, maxlength: '120', placeholder: b.needsApproval ? 'e.g. Group revision' : 'e.g. Extra tutorial' })),
    h('div', { class: 'door-book__row' },
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Type'),
        h('select', { name: 'category' }, cats.map((c) => h('option', { value: c }, CATEGORIES[c])))),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'People'),
        h('input', { name: 'attendees', type: 'number', min: '1', max: String(d.room.capacity), value: '1', inputmode: 'numeric', required: true }))),
    h('p', { class: 'alert', 'data-error': '', hidden: true }),
    submit,
    b.needsApproval ? h('p', { class: 'muted' }, 'Student requests are checked by the timetable office before the room is yours.') : '');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(form, '');
    const fd = new FormData(form);
    if (!String(fd.get('title')).trim()) { showError(form, 'Say what the booking is for.'); return; }
    submit.disabled = true;
    try {
      const { booking } = await api('/bookings', {
        method: 'POST',
        body: {
          roomId: d.room.id, title: fd.get('title'), category: fd.get('category'), date: b.date,
          start: b.start, end: fd.get('end'), attendees: Number(fd.get('attendees')),
        },
      });
      if (booking.status === 'approved') {
        // You are at the door already: check in straight away when it's close enough to the start.
        const checked = await checkIn(code, 'qr').then(() => true).catch(() => false);
        flash = checked
          ? `Booked and checked in: ${d.room.code} is yours ${booking.start_time}–${booking.end_time}.`
          : `Booked: ${d.room.code} ${booking.start_time}–${booking.end_time}. Check in here from ${fromMin(toMin(b.start) - d.checkIn.earlyMinutes)}.`;
      } else {
        flash = `Request sent for ${d.room.code} ${booking.start_time}–${booking.end_time}. You'll be told when it's approved.`;
      }
      await load();
    } catch (err) {
      submit.disabled = false;
      showError(form, err.message);
    }
  });
  return form;
}

/* ---------- Later today ------------------------------------------------------------- */

function laterList(d) {
  const items = [
    ...d.upcoming.map((b) => ({ start: b.start, el: h('li', { class: `door-later__item${b.mine ? ' is-mine' : ''}` },
      h('span', { class: 'mono' }, `${b.start}–${b.end}`),
      h('span', {}, b.title ? `${b.title}${b.courseCode ? ` · ${b.courseCode}` : ''}` : 'Booked', b.mine ? ' (yours)' : ''),
      b.status === 'pending' ? h('span', { class: 'tag tag--pending' }, 'requested') : '') })),
    ...(d.closures || []).map((c) => ({ start: c.start, el: h('li', { class: 'door-later__item' },
      h('span', { class: 'mono' }, `${c.start}–${c.end}`),
      h('span', {}, `Unavailable · ${c.reason}`)) })),
  ].sort((a, b) => (a.start < b.start ? -1 : 1));
  if (!items.length) return '';
  return h('section', { class: 'door-later' },
    h('h2', { class: 'panel__title' }, 'Later today'),
    h('ul', { class: 'door-later__list' }, items.map((i) => i.el)));
}

/* ---------- Page ------------------------------------------------------------------- */

function render(d) {
  document.title = `${d.room.code} · Room Door`;
  const r = d.room;
  box.replaceChildren(
    h('header', { class: 'door__head' },
      h('h1', { class: 'door__code mono' }, r.code),
      h('p', { class: 'door__where' }, `${r.name} · ${r.buildingName} · ${r.capacity} seats`),
      h('p', { class: 'door__doorcode mono' }, `Door code ${formatCode(code)}`)),
    flash ? h('p', { class: 'door__flash', role: 'status' }, flash) : '',
    h('p', { class: 'alert', 'data-error': '', hidden: true }),
    statusCard(d),
    mineCard(d),
    bookCard(d),
    laterList(d),
    h('p', { class: 'door__foot' }, h('a', { href: '/' }, 'Open the main site'), ' · ',
      h('a', { href: '/#/board' }, 'All rooms today')),
  );
  flash = null;
}

async function load() {
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    box.replaceChildren(h('section', { class: 'door-card panel' },
      h('h1', { class: 'serif door__missing' }, 'Scan the QR code on a room door'),
      h('p', {}, 'Each room has a sign by its door. Scanning it opens that room here.'),
      h('a', { class: 'button button--secondary', href: '/' }, 'Open the main site')));
    return;
  }
  try {
    render(await api(`/door/${code}`));
  } catch (err) {
    box.replaceChildren(h('section', { class: 'door-card panel' },
      h('h1', { class: 'serif door__missing' }, err.status === 404 ? 'This sign is out of date' : 'Could not load this room'),
      h('p', {}, err.status === 404
        ? 'The code on it no longer matches a room. Please tell the timetable office so they can print a new sign.'
        : err.message),
      h('a', { class: 'button button--secondary', href: '/' }, 'Open the main site')));
  }
}

tickClock();
setInterval(tickClock, 1000);
load();
// Keep it current while the page stays open (busy, free, check-in deadline).
setInterval(() => { if (!document.hidden && !$('[data-edit-sheet]').open && !box.contains(document.activeElement?.closest('input, select, textarea'))) load(); }, 30_000);
