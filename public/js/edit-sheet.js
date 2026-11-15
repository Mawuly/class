// The sliding glass editor sheet shared by the admin pages (rooms, people).
import { $ } from './util.js';

const sheet = $('[data-edit-sheet]');
const body = $('[data-edit-body]', sheet);
let opener = null;

/** Shows the sheet with a title and content; focus returns to the opener when it closes. */
export function openEditSheet(title, ...content) {
  if (!sheet.open) opener = document.activeElement;
  $('[data-edit-title]', sheet).textContent = title;
  body.replaceChildren(...content);
  document.body.classList.add('has-sheet');
  if (!sheet.open) sheet.showModal();
}

export function closeEditSheet() {
  if (sheet.open) sheet.close();
}

$('[data-edit-close]', sheet).addEventListener('click', closeEditSheet);
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeEditSheet(); });
sheet.addEventListener('close', () => {
  document.body.classList.remove('has-sheet');
  opener?.focus?.();
  opener = null;
});
