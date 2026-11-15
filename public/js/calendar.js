// "Add to calendar": a one-off .ics download, or a private link that calendar apps keep in step.
import { api } from './api.js';
import { h } from './util.js';
import { openEditSheet } from './edit-sheet.js';

function section(title, ...children) {
  return h('section', { class: 'cal-section' }, h('h3', { class: 'panel__title' }, title), ...children);
}

/** Shown once, right after a link is made: the token can't be shown again. */
function linkPanel(link) {
  const field = h('input', { class: 'mono cal-link__url', readonly: true, value: link.url, 'aria-label': 'Your calendar link' });
  field.addEventListener('focus', () => field.select());
  const copy = h('button', { class: 'button button--ink', type: 'button' }, 'Copy link');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link.url); copy.textContent = 'Copied'; } catch { field.select(); copy.textContent = 'Press Ctrl+C to copy'; }
  });
  return h('div', { class: 'cal-link', role: 'status' },
    h('p', { class: 'cal-link__label' }, 'Your calendar link'),
    h('div', { class: 'cal-link__row' }, field, copy),
    h('div', { class: 'cal-link__apps' },
      h('a', { class: 'button button--ink', href: link.google, target: '_blank', rel: 'noopener' }, 'Add to Google Calendar ↗'),
      h('a', { class: 'button button--ink', href: link.outlook, target: '_blank', rel: 'noopener' }, 'Add to Outlook ↗'),
      h('a', { class: 'button button--ink', href: link.webcal }, 'Apple Calendar')),
    h('p', { class: 'cal-link__hint' },
      'On an iPhone: Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, and paste the link. '
      + 'Calendars usually check for changes every few hours.'),
    h('p', { class: 'cal-link__hint' },
      'This link is shown only now. Anyone who has it can see your bookings’ titles and times, so keep it to yourself.'));
}

async function render(body, justMade = null) {
  const status = await api('/calendar/status');
  const made = status.createdAt
    ? new Date(status.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const error = h('p', { class: 'alert', 'data-error': '', hidden: true });
  const act = (label, fn, cls = 'button button--secondary') => {
    const b = h('button', { class: cls, type: 'button' }, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fn(); } catch (err) { error.textContent = err.message; error.hidden = false; b.disabled = false; }
    });
    return b;
  };
  const create = async () => render(body, await api('/calendar/feed', { method: 'POST' }));
  const remove = async () => { await api('/calendar/feed', { method: 'DELETE' }); await render(body); };

  body.replaceChildren(
    section('Download a file',
      h('p', { class: 'cal-text' }, 'All your upcoming bookings in one file. Open it with Google Calendar, Outlook or Apple Calendar. '
        + 'It’s a copy: later changes won’t show up in it.'),
      h('div', { class: 'sheet__actions' },
        h('a', { class: 'button button--secondary', href: '/api/bookings/mine.ics', download: '' }, 'Download .ics file'))),
    section('Subscribe: stays up to date',
      h('p', { class: 'cal-text' }, 'A private link your calendar checks by itself: new bookings appear, and cancelled or '
        + 'rejected ones disappear. Weekly bookings show every week.'),
      ...(justMade ? [linkPanel(justMade)] : []),
      ...(!justMade && status.hasFeed
        ? [h('p', { class: 'cal-text' }, `You made a calendar link on ${made}. For safety it’s shown only once. `
          + 'Make a new one if you need it again, or if someone else might have it: the old one stops working.')]
        : []),
      h('div', { class: 'sheet__actions' },
        status.hasFeed
          ? act(justMade ? 'Make another link' : 'Make a new link', create, 'button button--secondary')
          : act('Create my calendar link', create, 'button button--primary'),
        status.hasFeed ? act('Turn off', remove) : null),
      error));
}

export async function openCalendarSheet() {
  const body = h('div', { class: 'cal' }, h('p', { class: 'muted' }, 'Loading…'));
  openEditSheet('Add to your calendar', body);
  try {
    await render(body);
  } catch (err) {
    body.replaceChildren(h('p', { class: 'alert' }, err.message));
  }
}
