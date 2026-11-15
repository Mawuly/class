// Shows the "Continue with Google" buttons when the site has Google sign-in set up, points them
// back at the right page, and shows any message Google sign-in sent back (?auth_error=...).
const buttons = [...document.querySelectorAll('[data-google]')];

// Where to come back to: the page's own ?next= (e.g. from a door sign), else the button's own.
const pageNext = new URLSearchParams(location.search).get('next');
const safe = /^\/(admin|account\.html|booking\.html|door\?c=[A-Za-z0-9-]{6,7})?$/;

function showError(message) {
  const dialog = document.getElementById('auth-dialog');
  if (dialog && !dialog.open) dialog.showModal();
  const target = document.getElementById('auth-error') || document.getElementById('account-error')
    || document.querySelector('[data-form="portal-login"] [data-error]');
  if (!target) return;
  target.textContent = message;
  target.hidden = false;
}

async function init() {
  const params = new URLSearchParams(location.search);
  const error = params.get('auth_error');
  if (error) {
    params.delete('auth_error');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
  }
  try {
    const res = await fetch('/api/auth/options', { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'same-origin' });
    const { google } = await res.json();
    for (const el of buttons) {
      el.hidden = !google;
      if (el.tagName === 'A') {
        const next = pageNext && safe.test(pageNext) ? pageNext : el.dataset.next || '/';
        el.href = `/api/auth/google/start?next=${encodeURIComponent(next)}`;
      }
    }
  } catch { /* the buttons stay hidden; email and password still work */ }
  if (error) showError(error);
}

init();
