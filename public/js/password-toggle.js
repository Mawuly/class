// A "Show" button inside every password field, so people can check what they typed.
// Fields added later (in sheets) get one too.

function hide(input, button) {
  input.type = 'password';
  button.textContent = 'Show';
  button.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-label', 'Show password');
}

function enhance(input) {
  if (input.dataset.toggle) return;
  input.dataset.toggle = '1';
  const wrap = document.createElement('span');
  wrap.className = 'pw';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pw__toggle';
  input.replaceWith(wrap);
  wrap.append(input, button);
  hide(input, button);
  button.addEventListener('click', () => {
    if (input.type === 'password') {
      input.type = 'text';
      button.textContent = 'Hide';
      button.setAttribute('aria-pressed', 'true');
      button.setAttribute('aria-label', 'Hide password');
    } else {
      hide(input, button);
    }
    // Keep typing where you were.
    input.focus();
    const end = input.value.length;
    try { input.setSelectionRange(end, end); } catch { /* some input types don't allow it */ }
  });
  // Hidden again when the form is sent or cleared, so it's never left showing.
  input.form?.addEventListener('submit', () => hide(input, button));
  input.form?.addEventListener('reset', () => hide(input, button));
}

function scan(root) {
  if (root.matches?.('input[type="password"]')) enhance(root);
  root.querySelectorAll?.('input[type="password"]').forEach(enhance);
}

export function startPasswordToggles() {
  scan(document);
  new MutationObserver((changes) => {
    for (const c of changes) c.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); });
  }).observe(document.body, { childList: true, subtree: true });
}
