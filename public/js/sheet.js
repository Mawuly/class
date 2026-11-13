// The booking sheet: a glass panel that slides in from the right.
import { api } from './api.js';
import { $, $$, h, toMin, fromMin, longDate, isoDate, addDays, showError } from './util.js';

const STAFF_CATEGORIES = ['lecture', 'tutorial', 'lab', 'exam', 'meeting', 'study', 'event'];
const STUDENT_CATEGORIES = ['study', 'meeting', 'event'];
const LABELS = {
  lecture: 'Lecture', tutorial: 'Tutorial', lab: 'Practical / lab', exam: 'Exam',
  meeting: 'Meeting', study: 'Study', event: 'Event',
};

const dialog = $('[data-sheet]');
const form = $('[data-form="book"]', dialog);
const f = form.elements; // named fields; form.title would be the form's own title attribute
const ctx = { room: null, user: null, rules: null, onBooked: null, opener: null };

function option(value, label = value, selected = false) {
  return h('option', { value, selected }, label);
}

function fillStart(selected) {
  const { open, close, slotMinutes } = ctx.rules;
  const options = [];
  for (let m = toMin(open); m + slotMinutes <= toMin(close); m += slotMinutes) options.push(option(fromMin(m)));
  f.start.replaceChildren(...options);
  f.start.value = selected;
}

/** End times run from one slot after the start to the 6-hour limit or closing time. */
function fillEnd(selected) {
  const { close, slotMinutes, maxHours } = ctx.rules;
  const s = toMin(f.start.value);
  const last = Math.min(s + maxHours * 60, toMin(close));
  const options = [];
  for (let m = s + slotMinutes; m <= last; m += slotMinutes) {
    const mins = m - s;
    const length = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h${mins % 60 ? ' 30' : ''}`;
    options.push(option(fromMin(m), `${fromMin(m)}  (${length})`));
  }
  f.end.replaceChildren(...options);
  const wanted = toMin(selected || fromMin(s + 60));
  f.end.value = fromMin(Math.min(Math.max(wanted, s + slotMinutes), last));
}

function updateStub() {
  const r = ctx.room;
  $('[data-stub-room]', dialog).textContent = r.code;
  $('[data-stub-name]', dialog).textContent = `${r.name} · ${r.building_name} · ${r.capacity} seats`;
  $('[data-stub-when]', dialog).textContent = f.date.value
    ? `${longDate(f.date.value)} · ${f.start.value}–${f.end.value}`
    : '';
}

function clearMessages() {
  $('[data-clash]', dialog).hidden = true;
  showError(form, '');
}

function showClash(err) {
  const box = $('[data-clash]', dialog);
  const suggest = $('[data-suggest]', box);
  $('[data-clash-msg]', box).textContent = err.message;
  const s = err.data.suggestion;
  if (s) {
    suggest.textContent = `Try ${s.start}–${s.end}?`;
    suggest.onclick = () => {
      f.date.value = s.date;
      f.start.value = s.start;
      fillEnd(s.end);
      updateStub();
      clearMessages();
      $('[data-sheet-submit]', dialog).focus();
    };
  }
  suggest.hidden = !s;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showDone(booking) {
  const pending = booking.status === 'pending';
  const done = $('[data-done]', dialog);
  done.replaceChildren(
    h('p', { class: `done__state ${pending ? 'done__state--pending' : ''}` }, pending ? 'Request sent' : '■ Booked'),
    h('p', { class: 'done__text' }, pending
      ? `The timetable office will review your request for ${booking.room_code}. The slot is held for you until they decide, and you'll get a notification either way.`
      : `${booking.room_code} is yours on ${longDate(booking.date)}, ${booking.start_time}–${booking.end_time}.`),
    h('div', { class: 'sheet__actions' },
      h('button', { class: 'button button--primary', type: 'button', onclick: close }, 'Done')),
  );
  form.hidden = true;
  done.hidden = false;
  $('[data-sheet-title]', dialog).textContent = pending ? 'Request sent' : 'Booking confirmed';
  $('button', done).focus();
}

async function submit(e) {
  e.preventDefault();
  clearMessages();
  if (!f.title.value.trim()) {
    showError(form, 'Give the booking a title, so others know what the room is for.');
    f.title.focus();
    return;
  }
  const button = $('[data-sheet-submit]', dialog);
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    const { booking } = await api('/bookings', { method: 'POST', body: { ...body, roomId: ctx.room.id } });
    showDone(booking);
    ctx.onBooked?.(booking);
  } catch (err) {
    if (err.status === 409) showClash(err);
    else showError(form, err.message);
  } finally {
    button.disabled = false;
  }
}

function close() {
  if (dialog.open) dialog.close();
}

/**
 * Opens the sheet for a room.
 * prefill: { date, start, end, attendees }; options: { user, rules, onBooked }
 */
export function openSheet(room, prefill, { user, rules, onBooked }) {
  Object.assign(ctx, { room, user, rules, onBooked, opener: document.activeElement });
  const isStudent = user.role === 'student';

  form.reset();
  form.hidden = false;
  $('[data-done]', dialog).hidden = true;
  clearMessages();
  $('[data-sheet-title]', dialog).textContent = isStudent ? 'Request a room' : 'Book a room';

  const categories = isStudent ? STUDENT_CATEGORIES : STAFF_CATEGORIES;
  f.category.replaceChildren(...categories.map((c) => option(c, LABELS[c])));
  f.category.value = isStudent ? 'study' : 'lecture';
  $('[data-staff-only]', dialog).hidden = isStudent;
  f.title.placeholder = isStudent ? 'e.g. Group revision for MATH 221' : 'e.g. Data Structures lecture';

  const today = isoDate(new Date());
  f.date.min = today;
  f.date.max = addDays(today, rules.maxDaysAhead);
  f.date.value = prefill.date;
  fillStart(prefill.start);
  fillEnd(prefill.end);

  f.attendees.max = room.capacity;
  f.attendees.value = Math.min(room.capacity, Math.max(1, Number(prefill.attendees) || 1));
  $('[data-capacity-hint]', dialog).textContent = `Up to ${room.capacity} in ${room.code}`;

  $('[data-policy]', dialog).textContent = isStudent
    ? 'Student requests are reviewed by the timetable office. The slot is held for you while you wait.'
    : 'Staff bookings are confirmed straight away.';
  $('[data-sheet-submit]', dialog).textContent = `${isStudent ? 'Request' : 'Book'} ${room.code}`;

  updateStub();
  document.body.classList.add('has-sheet');
  dialog.showModal();
  f.title.focus();
}

form.addEventListener('submit', submit);
f.start.addEventListener('change', () => { fillEnd(f.end.value); updateStub(); clearMessages(); });
f.end.addEventListener('change', () => { updateStub(); clearMessages(); });
f.date.addEventListener('change', () => { updateStub(); clearMessages(); });
for (const b of $$('[data-sheet-close]', dialog)) b.addEventListener('click', close);
// A click on the dimmed backdrop (the dialog element itself, outside the panel) closes the sheet.
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
dialog.addEventListener('close', () => {
  document.body.classList.remove('has-sheet');
  ctx.opener?.focus?.();
});
