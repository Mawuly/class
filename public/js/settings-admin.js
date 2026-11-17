// Settings: the booking window for every room (opening time, closing time, longest booking).
import { api } from './api.js';
import { $, h, showError, toMin, fromMin } from './util.js';

const view = $('[data-view="settings"]');
const form = $('[data-form="settings"]', view);
const done = $('[data-settings-done]', view);

function times(from, to) {
  const out = [];
  for (let m = toMin(from); m <= toMin(to); m += 30) out.push(fromMin(m));
  return out;
}

function fill(s) {
  form.open.replaceChildren(...times('05:00', '22:00').map((t) => h('option', { value: t }, t)));
  form.close.replaceChildren(...times('06:00', '23:00').map((t) => h('option', { value: t }, t)));
  form.maxHours.replaceChildren(...[1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n) }, `${n} hour${n === 1 ? '' : 's'}`)));
  form.open.value = s.open;
  form.close.value = s.close;
  form.maxHours.value = String(s.maxHours);
  form.checkInLocation.value = s.checkInLocation || 'required';
  form.studentApproval.value = s.studentApproval || 'auto';
  describe();
}

/** A sentence saying what people will be able to book with these values. */
function describe() {
  const hours = (toMin(form.close.value) - toMin(form.open.value)) / 60;
  $('[data-settings-summary]', view).textContent = hours > 0
    ? `Bookings can start every half hour from ${form.open.value}, last 1 to ${form.maxHours.value} whole hour${form.maxHours.value === '1' ? '' : 's'}, `
      + `and must end by ${form.close.value} (${hours} h a day).`
    : 'Closing time must be after opening time.';
}

async function load() {
  showError(view, '');
  done.hidden = true;
  try {
    fill((await api('/admin/settings')).settings);
  } catch (err) {
    showError(view, err.message);
  }
}

form.addEventListener('change', () => { done.hidden = true; describe(); });
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(view, '');
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  try {
    const { settings } = await api('/admin/settings', {
      method: 'PATCH', body: { open: form.open.value, close: form.close.value, maxHours: Number(form.maxHours.value), checkInLocation: form.checkInLocation.value, studentApproval: form.studentApproval.value },
    });
    fill(settings);
    done.textContent = 'Saved. New bookings follow these times now; bookings already made are not changed.';
    done.hidden = false;
  } catch (err) {
    showError(view, err.message);
  } finally {
    button.disabled = false;
  }
});

export function showSettings() {
  load();
}
