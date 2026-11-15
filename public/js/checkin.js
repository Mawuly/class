// Check-in, shared by the dashboard and the door page.
import { api } from './api.js';
import { h, toMin, fromMin, isoDate, hhmm, showError } from './util.js';
import { openEditSheet, closeEditSheet } from './edit-sheet.js';

/** Mirrors the server's checkInState: early, open, checked-in, released, not-approved or ended. */
export function checkInState(b, rules, now = new Date()) {
  const start = toMin(b.start_time);
  const opensAt = fromMin(start - rules.checkInEarlyMinutes);
  const deadline = fromMin(start + rules.checkInGraceMinutes);
  const base = { opensAt, deadline };
  if (b.status === 'released') return { ...base, state: 'released' };
  if (b.checked_in_at) return { ...base, state: 'checked-in' };
  if (b.status !== 'approved') return { ...base, state: 'not-approved' };
  const today = isoDate(now);
  const time = toMin(hhmm(now));
  if (b.date > today || (b.date === today && time < start - rules.checkInEarlyMinutes)) return { ...base, state: 'early' };
  if (b.date < today || time >= toMin(b.end_time)) return { ...base, state: 'ended' };
  return { ...base, state: 'open' };
}

/** "k7p2qx" → "K7P-2QX" as it is typed. */
export function formatCode(value) {
  const raw = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
}

export const checkIn = (code, via = 'code') => api('/door/check-in', { method: 'POST', body: { code, via } });

/** A sheet asking for the code on the door, for when the QR code can't be scanned. */
export function openCheckInSheet(b, { onDone } = {}) {
  const input = h('input', {
    class: 'mono code-input', name: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    inputmode: 'text', maxlength: '7', placeholder: 'K7P-2QX', required: true, 'aria-describedby': 'code-hint',
  });
  input.addEventListener('input', () => { input.value = formatCode(input.value); });
  const submit = h('button', { class: 'button button--primary', type: 'submit' }, 'Check in');
  const form = h('form', { class: 'form', novalidate: true },
    h('p', { class: 'sheet__lead' }, `${b.room_code} · ${b.start_time}–${b.end_time} · ${b.title}`),
    h('label', { class: 'field' },
      h('span', { class: 'field__label' }, 'Code on the door sign'),
      input,
      h('span', { class: 'field__hint', id: 'code-hint' }, 'Six letters and numbers under the QR code. Scanning the QR code with your phone camera checks you in too.')),
    h('p', { class: 'alert', 'data-error': '', hidden: true }),
    h('div', { class: 'sheet__actions' }, submit,
      h('button', { class: 'button button--secondary', type: 'button', onclick: closeEditSheet }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(form, '');
    if (input.value.replace('-', '').length !== 6) { showError(form, 'Type the six letters and numbers from the sign.'); return; }
    submit.disabled = true;
    try {
      await checkIn(input.value);
      closeEditSheet();
      onDone?.();
    } catch (err) {
      showError(form, err.message);
    } finally {
      submit.disabled = false;
    }
  });
  openEditSheet('Check in', form);
  input.focus();
}

/**
 * Leaving early: ends the booking now so the rest of the slot is free for others.
 * Needs a second click within a few seconds, like Cancel.
 */
export function checkOutButton(b, { onDone, cls = 'link-button checkin__out' } = {}) {
  let armed = null;
  const label = 'Check out early';
  const button = h('button', { class: cls, type: 'button', 'aria-label': `Check out of ${b.room_code || 'this room'} now and free the rest of the booking` }, label);
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = 'Free the room now?';
      armed = setTimeout(() => { armed = null; button.textContent = label; }, 4000);
      return;
    }
    clearTimeout(armed);
    button.disabled = true;
    try {
      await api(`/bookings/${b.id}/check-out`, { method: 'POST' });
      onDone?.();
    } catch (err) {
      button.disabled = false;
      button.textContent = err.message;
    }
  });
  return button;
}

/** The check-in line on the dashboard's next-booking card (or nothing when it doesn't apply). */
export function checkInLine(b, rules, { onDone } = {}) {
  if (!rules?.checkInGraceMinutes) return '';
  const s = checkInState(b, rules);
  const release = rules.releaseNoShows;
  if (s.state === 'checked-in') {
    const at = new Date(b.checked_in_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const started = b.date === isoDate(new Date()) && hhmm(new Date()) > b.start_time;
    return h('div', { class: 'checkin checkin--done' }, h('span', { class: 'checkin__mark', 'aria-hidden': 'true' }, '✓'),
      h('span', {}, `Checked in at ${at}`),
      started && !b.checked_out_at ? checkOutButton(b, { onDone }) : '');
  }
  if (s.state === 'open') {
    return h('div', { class: 'checkin checkin--open' },
      h('button', { class: 'button button--primary', type: 'button', onclick: () => openCheckInSheet(b, { onDone }) }, 'Check in'),
      h('span', { class: 'checkin__text' }, release
        ? h('span', {}, 'by ', h('b', { class: 'mono' }, s.deadline), ', or the room is released for others')
        : 'Scan the QR code on the door or type its code'));
  }
  if (s.state === 'early' && b.date === isoDate(new Date())) {
    return h('div', { class: 'checkin' }, h('span', { class: 'checkin__text' },
      'Check in at the door from ', h('b', { class: 'mono' }, s.opensAt),
      release ? ` to ${s.deadline}. Scan the QR code by the door.` : '. Scan the QR code by the door.'));
  }
  return '';
}
