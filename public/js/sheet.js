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
const ctx = { room: null, user: null, rules: null, onBooked: null, opener: null, plan: null };

/* ---------- Weekly repeat (staff only) ------------------------------------------------- */

const repeatBox = $('[data-repeat]', dialog);
const repeatOn = $('[data-repeat-on]', dialog);
const repeatWeeks = $('[data-repeat-weeks]', dialog);
const planBox = $('[data-plan]', dialog);
const repeating = () => !repeatBox.hidden && repeatOn.checked;
const weekCount = () => Number(repeatWeeks.value);
const dayName = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long' });

function submitLabel() {
  if (!repeating()) return `${ctx.user.role === 'student' ? 'Request' : 'Book'} ${ctx.room.code}`;
  if (!ctx.plan) return `Check ${weekCount()} weeks`;
  const free = ctx.plan.filter((p) => p.ok).length;
  return free ? `Book ${free} week${free === 1 ? '' : 's'}` : 'No free weeks';
}

function updateRepeat() {
  $('[data-repeat-options]', dialog).hidden = !repeatOn.checked;
  if (f.date.value) {
    const last = addDays(f.date.value, 7 * (weekCount() - 1));
    $('[data-repeat-until]', dialog).textContent =
      `Every ${dayName(f.date.value)}, ${f.start.value}–${f.end.value} · last on ${longDate(last)}`;
  }
  const button = $('[data-sheet-submit]', dialog);
  button.textContent = submitLabel();
  const skip = $('[data-skip]', planBox);
  const free = ctx.plan?.filter((p) => p.ok).length ?? 1;
  button.disabled = repeating() && Boolean(ctx.plan) && (!free || (skip && !skip.checked));
}

/** Any change to the date, times or number of weeks means the weeks must be checked again. */
function invalidatePlan() {
  ctx.plan = null;
  planBox.hidden = true;
  planBox.replaceChildren();
  updateRepeat();
}

function renderPlan(plan) {
  ctx.plan = plan;
  const free = plan.filter((p) => p.ok);
  const blocked = plan.filter((p) => !p.ok);
  const items = plan.map((p) => h('li', { class: `plan__row${p.ok ? '' : ' is-blocked'}` },
    h('span', { class: 'plan__mark', 'aria-hidden': 'true' }, p.ok ? '✓' : '⚠'),
    h('span', { class: 'plan__date mono' }, longDate(p.date)),
    h('span', { class: 'plan__what' }, p.ok ? 'free' : p.reason)));
  const parts = [
    h('p', { class: 'plan__summary' }, blocked.length
      ? `${free.length} of ${plan.length} weeks are free.`
      : `All ${plan.length} weeks are free.`),
    h('ol', { class: 'plan__list' }, items),
  ];
  if (blocked.length && free.length) {
    const skip = h('input', { type: 'checkbox', 'data-skip': '', checked: true });
    skip.addEventListener('change', updateRepeat);
    parts.push(h('label', { class: 'check check--block plan__skip' }, skip,
      h('span', {}, `Book the ${free.length} free week${free.length === 1 ? '' : 's'} and skip `
        + `${blocked.length === 1 ? 'the one that clashes' : `the ${blocked.length} that clash`}`)));
  }
  if (!free.length) parts.push(h('p', { class: 'plan__summary' }, 'Try another time or room.'));
  planBox.replaceChildren(...parts);
  planBox.hidden = false;
  updateRepeat();
}

function showSeriesDone(r) {
  const done = $('[data-done]', dialog);
  // replaceChildren would print "null" for an empty slot, so leave empty slots out.
  done.replaceChildren(...[
    h('p', { class: 'done__state' }, `■ Booked ${r.booked.length} weeks`),
    h('p', { class: 'done__text' }, `${r.room} is yours every ${dayName(r.booked[0])}, ${r.start}–${r.end}, `
      + `from ${longDate(r.booked[0])} to ${longDate(r.booked[r.booked.length - 1])}.`),
    r.skipped.length
      ? h('p', { class: 'done__text' }, `Skipped: ${r.skipped.map((s) => longDate(s.date)).join(', ')}. Book those weeks separately if you need them.`)
      : null,
    h('p', { class: 'done__text muted' }, 'You can cancel single weeks, or the whole series, from Coming up on your dashboard.'),
    h('div', { class: 'sheet__actions' },
      h('button', { class: 'button button--primary', type: 'button', onclick: close }, 'Done'),
      // The series' weeks are all upcoming bookings, so the "all my bookings" file includes them.
      h('a', { class: 'button button--secondary', href: '/api/bookings/mine.ics', download: '' }, 'Add to calendar')),
  ].filter(Boolean));
  form.hidden = true;
  done.hidden = false;
  $('[data-sheet-title]', dialog).textContent = 'Weekly booking confirmed';
  $('button', done).focus();
}

async function submitSeries(button) {
  const body = { ...Object.fromEntries(new FormData(form)), roomId: ctx.room.id, weeks: weekCount() };
  if (!ctx.plan) {
    const r = await api('/bookings/series/preview', { method: 'POST', body });
    renderPlan(r.dates);
    planBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  try {
    const result = await api('/bookings/series', {
      method: 'POST', body: { ...body, skipClashes: Boolean($('[data-skip]', planBox)?.checked) },
    });
    showSeriesDone(result);
    ctx.onBooked?.(result);
  } catch (err) {
    // Someone booked one of the weeks since the check: show the weeks as they are now.
    if (err.status === 409 && err.data.dates) {
      renderPlan(err.data.dates);
      showError(form, 'One of the weeks was just booked by someone else. The list is up to date now.');
      return;
    }
    throw err;
  } finally {
    button.disabled = false;
    updateRepeat();
  }
}

repeatOn.addEventListener('change', () => { invalidatePlan(); });
repeatWeeks.addEventListener('change', invalidatePlan);

function option(value, label = value, selected = false) {
  return h('option', { value, selected }, label);
}

function fillStart(selected) {
  const { open, close, slotMinutes } = ctx.rules;
  const options = [];
  // Starts every half hour; the shortest booking is one hour, so the last start is an hour before closing.
  for (let m = toMin(open); m + 60 <= toMin(close); m += slotMinutes) options.push(option(fromMin(m)));
  f.start.replaceChildren(...options);
  f.start.value = selected;
}

/** Bookings last whole hours: end times run one hour at a time up to the longest class or closing time. */
function fillEnd(selected) {
  const { close, maxHours } = ctx.rules;
  const s = toMin(f.start.value);
  const last = Math.min(s + maxHours * 60, toMin(close));
  const options = [];
  for (let m = s + 60; m <= last; m += 60) options.push(option(fromMin(m), `${fromMin(m)}  (${(m - s) / 60} h)`));
  f.end.replaceChildren(...options);
  // Keep the wanted length, rounded to whole hours.
  const wanted = Math.round((toMin(selected || fromMin(s + 60)) - s) / 60) * 60 + s;
  f.end.value = fromMin(Math.min(Math.max(wanted, s + 60), Math.floor((last - s) / 60) * 60 + s));
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
      h('button', { class: 'button button--primary', type: 'button', onclick: close }, 'Done'),
      h('a', { class: 'button button--secondary', href: `/api/bookings/${booking.id}/calendar.ics`, download: '' }, 'Add to calendar')),
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
  if (repeating()) {
    try {
      await submitSeries(button);
    } catch (err) {
      showError(form, err.message);
      button.disabled = false;
    }
    return;
  }
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
  // Course code and supervisor are open to everyone (a student request may be for a course or a project).
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

  // Weekly repeat is for staff. Default to 12 weeks: roughly a semester's teaching.
  repeatBox.hidden = isStudent;
  repeatOn.checked = false;
  repeatWeeks.replaceChildren(...Array.from({ length: 15 }, (_, i) => option(String(i + 2), `${i + 2} weeks`)));
  repeatWeeks.value = '12';
  invalidatePlan();

  updateStub();
  document.body.classList.add('has-sheet');
  dialog.showModal();
  f.title.focus();
}

form.addEventListener('submit', submit);
f.start.addEventListener('change', () => { fillEnd(f.end.value); updateStub(); clearMessages(); invalidatePlan(); });
f.end.addEventListener('change', () => { updateStub(); clearMessages(); invalidatePlan(); });
f.date.addEventListener('change', () => { updateStub(); clearMessages(); invalidatePlan(); });
for (const b of $$('[data-sheet-close]', dialog)) b.addEventListener('click', close);
// A click on the dimmed backdrop (the dialog element itself, outside the panel) closes the sheet.
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
dialog.addEventListener('close', () => {
  document.body.classList.remove('has-sheet');
  ctx.opener?.focus?.();
});
