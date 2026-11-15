// Temporary unavailability: the timetable office closes a room for a time on a date
// (maintenance, exams, events). Shown on the Rooms page; also reachable from a room's editor.
import { api } from './api.js';
import { h, showError, isoDate, longDate, toMin, fromMin } from './util.js';
import { openEditSheet, closeEditSheet } from './edit-sheet.js';

const REASONS = ['Maintenance', 'Examination', 'University event', 'Cleaning'];

function times(from = '05:00', to = '23:00') {
  const out = [];
  for (let m = toMin(from); m <= toMin(to); m += 30) out.push(fromMin(m));
  return out;
}

/**
 * The sheet for a new closure. `rooms` are the active rooms to choose from; `roomId` preselects one.
 * Closures may be half an hour long (bookings must be whole hours).
 */
export function openClosureSheet({ rooms, roomId = null, rules, onDone }) {
  const active = rooms.filter((x) => x.is_active);
  const room = h('select', { name: 'roomId', required: true },
    active.map((x) => h('option', { value: String(x.id), selected: x.id === roomId }, `${x.code} · ${x.name}`)));
  const date = h('input', { name: 'date', type: 'date', class: 'mono', required: true, min: isoDate(new Date()), value: isoDate(new Date()) });
  const all = times(rules?.open || '06:30', rules?.close || '20:30');
  const start = h('select', { name: 'start', class: 'mono' }, all.slice(0, -1).map((t) => h('option', { value: t }, t)));
  const end = h('select', { name: 'end', class: 'mono' }, all.slice(1).map((t) => h('option', { value: t }, t)));
  end.value = all[all.length - 1];
  const reason = h('input', { name: 'reason', required: true, minlength: '3', maxlength: '300', placeholder: 'e.g. Electrical maintenance' });
  const chips = h('div', { class: 'chips' }, REASONS.map((text) => h('button', {
    class: 'chip', type: 'button', onclick: () => { reason.value = text; reason.focus(); },
  }, text)));
  const clash = h('div', { class: 'clash', hidden: true });
  const submit = h('button', { class: 'button button--primary', type: 'submit' }, 'Make unavailable');
  const form = h('form', { class: 'form', novalidate: true },
    h('p', { class: 'sheet__lead' }, 'The room stays in the system and is bookable again when this time is over. '
      + 'Bookings already made are not cancelled: cancel or reject them first.'),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Room'), room),
    h('div', { class: 'field-row field-row--3' },
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Date'), date),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'From'), start),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'To'), end)),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Reason'), reason,
      h('span', { class: 'field__hint' }, 'People see this on the day board, the room\'s week and its door page.')),
    chips,
    clash,
    h('p', { class: 'alert', 'data-error': '', hidden: true }),
    h('div', { class: 'sheet__actions' }, submit,
      h('button', { class: 'button button--secondary', type: 'button', onclick: closeEditSheet }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(form, '');
    clash.hidden = true;
    if (end.value <= start.value) { showError(form, 'The end time must be after the start time.'); return; }
    submit.disabled = true;
    try {
      await api('/admin/room-blocks', {
        method: 'POST',
        body: { roomId: Number(room.value), date: date.value, start: start.value, end: end.value, reason: reason.value },
      });
      closeEditSheet();
      await onDone?.();
    } catch (err) {
      showError(form, err.message);
      // Show what is in the way, so the office can cancel or reject it first.
      const items = [
        ...(err.data?.bookings || []).map((b) => `${b.start_time}–${b.end_time} · ${b.course_code ? `${b.course_code} · ` : ''}${b.title} (${b.user_name}${b.status === 'pending' ? ', awaiting approval' : ''})`),
        ...(err.data?.blocks || []).map((b) => `${b.start_time}–${b.end_time} · already unavailable: ${b.reason}`),
      ];
      if (items.length) {
        clash.replaceChildren(h('p', { class: 'clash__msg' }, 'In the way:'), h('ul', { class: 'clash__list mono' }, items.map((t) => h('li', {}, t))));
        clash.hidden = false;
      }
    } finally {
      submit.disabled = false;
    }
  });
  openEditSheet('Make a room unavailable', form);
  reason.focus();
}

/** The list on the Rooms page: every upcoming closure, each with "Make available". */
export function closuresPanel({ blocks, rooms, rules, onChange }) {
  const add = h('button', { class: 'button button--secondary', type: 'button', onclick: () => openClosureSheet({ rooms, rules, onDone: onChange }) },
    '+ Make a room unavailable');
  const rows = blocks.map((b) => {
    let armed = null;
    const free = h('button', { class: 'link-button', type: 'button', 'aria-label': `Make ${b.room_code} available again on ${longDate(b.date)} ${b.start_time}–${b.end_time}` }, 'Make available');
    free.addEventListener('click', async () => {
      if (!armed) {
        free.textContent = 'Click again';
        armed = setTimeout(() => { armed = null; free.textContent = 'Make available'; }, 4000);
        return;
      }
      clearTimeout(armed);
      free.disabled = true;
      try {
        await api(`/admin/room-blocks/${b.id}`, { method: 'DELETE' });
        await onChange?.();
      } catch (err) {
        free.disabled = false;
        free.textContent = err.message;
      }
    });
    return h('li', { class: 'closure' },
      h('span', { class: 'closure__room mono' }, b.room_code),
      h('span', { class: 'closure__when mono' }, `${longDate(b.date)} · ${b.start_time}–${b.end_time}`),
      h('span', { class: 'closure__why' }, b.reason, h('small', {}, ` · by ${b.created_by_name}`)),
      free);
  });
  return h('section', { class: 'closures', 'aria-labelledby': 'closures-title' },
    h('div', { class: 'closures__head' },
      h('h2', { class: 'panel__title', id: 'closures-title' }, `Temporary unavailability${blocks.length ? ` · ${blocks.length}` : ''}`),
      add),
    blocks.length
      ? h('ul', { class: 'closures__list' }, rows)
      : h('p', { class: 'muted closures__empty' }, 'No room is closed. Close one for maintenance, an exam or an event; it becomes bookable again afterwards.'));
}
