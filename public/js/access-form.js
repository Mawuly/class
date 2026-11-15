// The staff verification fields (staff ID, position, department, offer or appointment letter),
// used at sign-up and from the dashboard. Also sends the request.
import { api } from './api.js';
import { h } from './util.js';

const MAX_BYTES = 3 * 1024 * 1024;
const TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

let instance = 0;

export const ROLE_LABEL = { lecturer: 'Lecturer', admin: 'Timetable office (admin)' };

function size(n) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Phone photos of letters are often 5–10 MB. Scale images to at most 2000 px on the long side
 * and re-encode as JPEG, which keeps a letter readable at a few hundred KB.
 */
async function shrinkImage(file) {
  if (!file.type.startsWith('image/')) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 1.5 * 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('The file could not be read'));
    reader.readAsDataURL(file);
  });
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), input,
    hint ? h('span', { class: 'field__hint' }, hint) : null);
}

/**
 * Builds the staff fields. roles: which roles can be chosen inside the fieldset (the sign-up form
 * chooses the role itself, so it passes none). Returns { el, validate(), payload(role), reset() }.
 */
export function staffFields({ roles = [], department = '' } = {}) {
  let file = null;
  const hintId = `upload-hint-${++instance}`;
  const roleSelect = roles.length > 1
    ? h('select', { 'aria-label': 'Access you need' }, roles.map((r) => h('option', { value: r }, ROLE_LABEL[r])))
    : null;
  const staffId = h('input', { class: 'mono', maxlength: '30', autocomplete: 'off', placeholder: 'e.g. UG/STF/2291' });
  const position = h('input', { maxlength: '80', placeholder: 'e.g. Lecturer, Timetable Officer' });
  const dept = h('input', { maxlength: '80', value: department, placeholder: 'e.g. Computer Science' });
  const note = h('textarea', { rows: '2', maxlength: '500', placeholder: 'Anything the timetable office should know (optional)' });

  const fileInput = h('input', {
    type: 'file', class: 'upload__input', accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png',
    'aria-describedby': hintId,
  });
  const fileName = h('span', { class: 'upload__name' }, 'No file chosen');
  const fileError = h('span', { class: 'upload__error', hidden: true, role: 'alert' });
  const drop = h('label', { class: 'upload' },
    fileInput,
    h('span', { class: 'upload__button' }, 'Choose letter'),
    fileName);

  async function choose(f) {
    fileError.hidden = true;
    file = null;
    drop.classList.remove('has-file');
    if (!f) { fileName.textContent = 'No file chosen'; return; }
    if (!TYPES.includes(f.type) && !/\.(pdf|jpe?g|png)$/i.test(f.name)) {
      fileError.textContent = 'Choose a PDF, JPG or PNG file';
      fileError.hidden = false;
      fileName.textContent = 'No file chosen';
      return;
    }
    fileName.textContent = `Preparing ${f.name}…`;
    const ready = await shrinkImage(f);
    if (ready.size > MAX_BYTES) {
      fileError.textContent = `${f.name} is ${size(ready.size)}. The limit is 3 MB: try a scan or a smaller PDF.`;
      fileError.hidden = false;
      fileName.textContent = 'No file chosen';
      return;
    }
    file = ready;
    drop.classList.add('has-file');
    fileName.textContent = `${f.name} · ${size(ready.size)}${ready !== f ? ' (resized)' : ''}`;
  }
  fileInput.addEventListener('change', () => choose(fileInput.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    choose(e.dataTransfer.files[0]);
  });

  const el = h('fieldset', { class: 'staff' },
    h('legend', { class: 'staff__legend' }, 'Staff verification'),
    h('p', { class: 'staff__intro' },
      'Your account starts with student access. The timetable office checks your letter and then gives you staff access, '
      + 'usually within one working day. Your letter is deleted as soon as they decide.'),
    roleSelect ? field('Access you need', roleSelect) : null,
    h('div', { class: 'field-row' }, field('Staff ID number', staffId), field('Position', position)),
    field('Department or unit', dept),
    h('div', { class: 'field' },
      h('span', { class: 'field__label' }, 'Offer or appointment letter'),
      drop,
      h('span', { class: 'field__hint', id: hintId }, 'PDF, JPG or PNG, up to 3 MB. A clear photo of the signed letter is fine.'),
      fileError),
    field('Note', note));

  return {
    el,
    /** Returns an error message, or null when everything needed is filled in. */
    validate() {
      if (staffId.value.trim().length < 2) { staffId.focus(); return 'Enter your staff ID number'; }
      if (position.value.trim().length < 2) { position.focus(); return 'Enter your position'; }
      if (!dept.value.trim()) { dept.focus(); return 'Enter your department or unit'; }
      if (!file) { fileInput.focus(); return 'Attach your offer or appointment letter'; }
      return null;
    },
    async send(role) {
      const data = await toBase64(file);
      const { request } = await api('/access-requests', {
        method: 'POST',
        body: {
          role: role || roleSelect?.value || roles[0],
          staffId: staffId.value, position: position.value, department: dept.value, note: note.value,
          document: { name: file.name, type: file.type, data },
        },
      });
      return request;
    },
  };
}
