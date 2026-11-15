const forms = [...document.querySelectorAll('[data-account-form]')];
const error = document.getElementById('account-error');
const message = document.getElementById('account-message');
function route() {
  const name = location.hash.slice(1) || 'login';
  const selected = forms.find(f => f.dataset.accountForm === name) || forms[0];
  forms.forEach(f => { f.hidden = f !== selected; });
  error.textContent = ''; message.textContent = '';
  document.title = `${selected.querySelector('h1').textContent} · UCC Spaces`;
}
window.addEventListener('hashchange', route); route();
document.querySelectorAll('[data-toggle-password]').forEach(b => b.addEventListener('click', () => {
  const input = b.previousElementSibling; const show = input.type === 'password';
  input.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} password`);
}));
const endpoints = { login: 'login', register: 'register', forgot: 'forgot-password', reset: 'reset-password', change: 'change-password' };
for (const form of forms) form.addEventListener('submit', async e => {
  e.preventDefault(); error.textContent = ''; message.textContent = '';
  const data = Object.fromEntries(new FormData(form));
  if ('confirm' in data && data.confirm !== (data.password || data.newPassword)) { error.textContent = 'Passwords do not match.'; return; }
  delete data.confirm;
  const type = form.dataset.accountForm, submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try {
    const res = await fetch(`/api/auth/${endpoints[type]}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status >= 500 ? 'Accounts are temporarily unavailable. You can still browse classrooms.' : body.error || 'Unable to complete this request.');
    if (type === 'forgot') {
      if (body.method === 'code') {
        location.hash = 'reset'; route();
        forms.find(f => f.dataset.accountForm === 'reset').elements.email.value = data.email;
        message.textContent = 'If your account is eligible, a reset code will be sent to your registered email or verified phone.';
      } else { message.textContent = 'Contact the timetable office with your student or staff ID to reset your password.'; }
    } else if (body.user?.mustChangePassword) { location.hash = 'change'; }
    else { location.assign('/'); }
  } catch (err) { error.textContent = err.name === 'TimeoutError' || err instanceof TypeError ? 'Cannot reach the account service. You can still browse classrooms.' : err.message; }
  finally { submit.disabled = false; }
});
