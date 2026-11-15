// "Phone for password reset" in the account sheet: add a number, confirm it with a texted code,
// change or remove it.
import { api } from './api.js';
import { h, showError } from './util.js';

/**
 * Builds the section. user: the signed-in user (with .phone when confirmed).
 * onChange(phone): called after the number is confirmed or removed.
 */
export function phoneSection(user, onChange) {
  const box = h('section', { class: 'phone-box' });
  const error = () => h('p', { class: 'alert', 'data-error': '', hidden: true });

  function confirmed(phone) {
    box.replaceChildren(
      h('h3', { class: 'panel__title' }, 'Phone for password reset'),
      h('p', { class: 'phone-box__number mono' }, phone, h('span', { class: 'phone-box__ok' }, ' ✓ confirmed')),
      h('p', { class: 'phone-box__text' }, 'If you forget your password, the reset code is texted to this number.'),
      h('div', { class: 'sheet__actions' },
        h('button', { class: 'button button--secondary', type: 'button', onclick: () => enter('') }, 'Change number'),
        h('button', {
          class: 'button button--secondary', type: 'button',
          onclick: async () => { await api('/auth/phone', { method: 'DELETE' }); onChange(null); enter(''); },
        }, 'Remove')));
  }

  function enter(prefill) {
    const input = h('input', { type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', class: 'mono', placeholder: '024 123 4567', value: prefill });
    const send = h('button', { class: 'button button--primary', type: 'submit' }, 'Text me a code');
    const err = error();
    const form = h('form', { class: 'form', novalidate: true },
      h('h3', { class: 'panel__title' }, 'Phone for password reset'),
      h('p', { class: 'phone-box__text' }, 'Add your Ghana mobile number so you can reset your password by text message if you forget it.'),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Mobile number'), input),
      err,
      h('div', { class: 'sheet__actions' }, send));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError(form, '');
      send.disabled = true;
      try {
        const r = await api('/auth/phone', { method: 'POST', body: { phone: input.value } });
        code(r.phone, r.minutes, input.value);
      } catch (ex) {
        showError(form, ex.message);
      } finally {
        send.disabled = false;
      }
    });
    box.replaceChildren(form);
  }

  function code(phone, minutes, typed) {
    const input = h('input', {
      class: 'mono code-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '7', placeholder: '000 000',
      'aria-label': 'Code from the text message',
    });
    input.addEventListener('input', () => {
      const d = input.value.replace(/\D/g, '').slice(0, 6);
      input.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
    });
    const ok = h('button', { class: 'button button--primary', type: 'submit' }, 'Confirm number');
    const form = h('form', { class: 'form', novalidate: true },
      h('h3', { class: 'panel__title' }, 'Phone for password reset'),
      h('p', { class: 'phone-box__text' }, `We’ve texted a 6-digit code to ${phone}. It works for ${minutes} minutes.`),
      input,
      error(),
      h('div', { class: 'sheet__actions' }, ok,
        h('button', { class: 'button button--secondary', type: 'button', onclick: () => enter(typed) }, 'Wrong number?')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError(form, '');
      ok.disabled = true;
      try {
        const r = await api('/auth/phone/verify', { method: 'POST', body: { code: input.value } });
        onChange(r.phone);
        confirmed(r.phone);
      } catch (ex) {
        showError(form, ex.message);
      } finally {
        ok.disabled = false;
      }
    });
    box.replaceChildren(form);
    input.focus();
  }

  if (user.phone) confirmed(user.phone); else enter('');
  return box;
}
