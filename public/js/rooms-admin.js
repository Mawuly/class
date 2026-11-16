// Room management for admins: add, edit, deactivate and delete rooms and buildings.
import { api } from './api.js';
import { $, $$, h, showError } from './util.js';
import { openEditSheet, closeEditSheet } from './edit-sheet.js';
import { closuresPanel, openClosureSheet } from './closures-admin.js';

const view = $('[data-view="rooms"]');
const table = $('[data-rooms-table]', view);

const TYPE_LABEL = {
  lecture_hall: 'Lecture hall', lab: 'Lab', seminar: 'Seminar room', study: 'Study room', meeting: 'Meeting room',
};
const FACILITY_LABEL = {
  projector: 'Projector', whiteboard: 'Whiteboard', pa_system: 'PA system', ac: 'Air conditioning',
  computers: 'Computers', video_conf: 'Video conferencing',
};
const facilityLabel = (k) => FACILITY_LABEL[k] || k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const r = {
  data: null,            // { buildings, rooms, types }
  search: '',
  buildingId: '',
  showInactive: false,
  onChange: null,        // app.js refreshes cached room lists after an edit
};

/* ---------- Table ------------------------------------------------------------------ */

function roomRow(room) {
  const who = room.bookable_by === 'staff' ? 'Staff only' : 'Everyone';
  return h('div', { class: `rt-row${room.is_active ? '' : ' rt-row--inactive'}`, role: 'row' },
    h('span', { class: 'rt-code mono', role: 'cell' },
      room.is_active ? h('a', { href: `/#/room/${room.id}`, title: `See ${room.code}'s week on the main site` }, room.code) : room.code),
    h('span', { class: 'rt-name', role: 'cell' }, room.name,
      room.is_active ? null : h('span', { class: 'tag tag--cancelled' }, 'inactive')),
    h('span', { class: 'rt-type', role: 'cell' }, TYPE_LABEL[room.type] || room.type),
    h('span', { class: 'rt-seats mono', role: 'cell' }, room.capacity),
    h('span', { class: 'rt-floor mono', role: 'cell' }, room.floor),
    h('span', { class: 'rt-fac mono', role: 'cell' }, room.facilities.map(facilityLabel).join(' · ') || '—'),
    h('span', { class: 'rt-who', role: 'cell' }, who),
    h('span', { class: 'rt-up mono', role: 'cell', title: 'Upcoming bookings' }, room.upcoming || ''),
    h('span', { class: 'rt-act', role: 'cell' },
      room.is_active ? h('a', { class: 'link-button', href: `/door-signs?room=${room.id}`, 'aria-label': `Door sign for ${room.code}` }, 'Sign') : '',
      h('button', { class: 'link-button', type: 'button', 'aria-label': `Edit ${room.code}`, onclick: () => openRoom(room) }, 'Edit')));
}

function render() {
  const { buildings, rooms } = r.data;
  const q = r.search.toLowerCase();
  const visible = rooms.filter((x) => (r.showInactive || x.is_active)
    && (!r.buildingId || String(x.building_id) === r.buildingId)
    && (!q || x.code.toLowerCase().includes(q) || x.name.toLowerCase().includes(q)));

  const active = rooms.filter((x) => x.is_active).length;
  const inactive = rooms.length - active;
  $('[data-rooms-summary]', view).textContent = `${active} rooms in ${buildings.length} building${buildings.length === 1 ? '' : 's'}`
    + `${inactive ? ` · ${inactive} inactive` : ''} · ${rooms.reduce((n, x) => n + x.capacity * (x.is_active ? 1 : 0), 0)} seats`;

  const head = h('div', { class: 'rt-row rt-row--head', role: 'row' },
    ...['Room', 'Name', 'Type', 'Seats', 'Floor', 'Facilities', 'Who can book', 'Upcoming', ''].map((t) => h('span', { role: 'columnheader' }, t)));

  const sections = buildings
    .filter((b) => !r.buildingId || String(b.id) === r.buildingId)
    .map((b) => {
      const list = visible.filter((x) => x.building_id === b.id);
      if (!list.length && q) return null; // while searching, hide buildings with no match
      return h('section', { class: 'rt-group', 'aria-label': `${b.code} ${b.name}` },
        h('div', { class: 'rt-group__head' },
          h('span', { class: 'mono rt-group__code' }, b.code),
          h('span', { class: 'rt-group__name' }, b.name),
          h('span', { class: 'mono rt-group__count' }, `${b.room_count} room${b.room_count === 1 ? '' : 's'}`
            + `${b.room_count && b.latitude == null ? ' · no location for check-in' : ''}`),
          h('button', { class: 'link-button', type: 'button', 'aria-label': `Edit building ${b.code}`, onclick: () => openBuilding(b) }, 'Edit building'),
          h('button', { class: 'link-button', type: 'button', onclick: () => openRoom(null, b.id) }, '+ Room here')),
        list.length
          ? h('div', { class: 'rt-rows', role: 'rowgroup' }, list.map(roomRow))
          : h('p', { class: 'rt-empty' }, b.room_count ? 'Only inactive rooms. Tick "Show inactive" to see them.' : 'No rooms yet.'));
    })
    .filter(Boolean);

  table.replaceChildren(
    h('div', { role: 'table', 'aria-label': 'Rooms' }, head, ...sections),
    sections.length ? '' : h('p', { class: 'rt-empty' }, buildings.length ? 'No rooms match.' : 'No buildings yet. Add one to start.'),
  );
}

function fillBuildingFilter() {
  const select = $('[data-rooms-building]', view);
  select.replaceChildren(h('option', { value: '' }, 'All buildings'),
    ...r.data.buildings.map((b) => h('option', { value: String(b.id) }, `${b.code} · ${b.name}`)));
  if (!r.data.buildings.some((b) => String(b.id) === r.buildingId)) r.buildingId = '';
  select.value = r.buildingId;
}

async function load() {
  showError(view, '');
  try {
    const [data, closures, settings] = await Promise.all([api('/admin/rooms'), api('/admin/room-blocks'), api('/admin/settings')]);
    r.data = data;
    r.blocks = closures.blocks;
    r.rules = settings.settings;
    $('[data-closures]', view).replaceChildren(closuresPanel({ blocks: r.blocks, rooms: r.data.rooms, rules: r.rules, onChange: load }));
    fillBuildingFilter();
    render();
  } catch (err) {
    showError(view, err.message);
  }
}

async function changed() {
  await load();
  await r.onChange?.();
}

/* ---------- Editor sheet ------------------------------------------------------------ */

const closeSheet = closeEditSheet;

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), input,
    hint ? h('span', { class: 'field__hint' }, hint) : null);
}

function errorBox() {
  return h('p', { class: 'alert', 'data-error': '', hidden: true });
}

/** A button that needs a second click within 4 seconds. */
function confirmButton(label, confirmLabel, action, cls = 'button button--secondary') {
  let armed = null;
  const btn = h('button', { class: cls, type: 'button' }, label);
  btn.addEventListener('click', async () => {
    if (!armed) {
      btn.textContent = confirmLabel;
      armed = setTimeout(() => { armed = null; btn.textContent = label; }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    btn.disabled = true;
    try { await action(); } finally { btn.disabled = false; btn.textContent = label; }
  });
  return btn;
}

function knownFacilities(extra = []) {
  const all = new Set([...Object.keys(FACILITY_LABEL), ...r.data.rooms.flatMap((x) => x.facilities), ...extra]);
  return [...all].sort((a, b) => facilityLabel(a).localeCompare(facilityLabel(b)));
}

function facilityPicker(selected) {
  const chosen = new Set(selected);
  const wrap = h('div', { class: 'chips chips--toggle', role: 'group', 'aria-label': 'Facilities' });
  const draw = () => {
    wrap.replaceChildren(...knownFacilities([...chosen]).map((k) => h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(chosen.has(k)),
      onclick: () => { if (chosen.has(k)) chosen.delete(k); else chosen.add(k); draw(); },
    }, facilityLabel(k))));
  };
  draw();
  const add = h('input', { placeholder: 'Add another, e.g. Smart board', maxlength: '30', 'aria-label': 'Add a facility' });
  add.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const key = add.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (key) { chosen.add(key); add.value = ''; draw(); }
  });
  return { el: h('div', { class: 'facilities' }, wrap, add), value: () => [...chosen] };
}

function openRoom(room, buildingId) {
  const editing = Boolean(room);
  const v = room || { building_id: buildingId || r.data.buildings[0]?.id, code: '', name: '', type: 'seminar', capacity: 30, floor: 0, facilities: [], bookable_by: 'all' };
  if (!r.data.buildings.length) {
    showError(view, 'Add a building first.');
    return;
  }
  const building = h('select', { name: 'buildingId' }, r.data.buildings.map((b) => h('option', { value: String(b.id) }, `${b.code} · ${b.name}`)));
  building.value = String(v.building_id);
  const code = h('input', { name: 'code', class: 'mono', maxlength: '20', required: true, placeholder: 'LT-4', value: v.code, autocapitalize: 'characters' });
  const name = h('input', { name: 'name', maxlength: '80', required: true, placeholder: 'Lecture Theatre 4', value: v.name });
  const type = h('select', { name: 'type' }, r.data.types.map((t) => h('option', { value: t }, TYPE_LABEL[t] || t)));
  type.value = v.type;
  const capacity = h('input', { name: 'capacity', type: 'number', min: '1', max: '2000', class: 'mono', value: String(v.capacity) });
  const floor = h('input', { name: 'floor', type: 'number', min: '-5', max: '50', class: 'mono', value: String(v.floor) });
  const who = (val, label, hint) => h('label', { class: 'radio' },
    h('input', { type: 'radio', name: 'bookableBy', value: val, checked: v.bookable_by === val }),
    h('span', {}, h('b', {}, label), h('small', {}, hint)));
  const whoGroup = h('fieldset', { class: 'radios' }, h('legend', { class: 'field__label' }, 'Who can book it'),
    who('all', 'Everyone', 'Staff book straight away; students send a request for approval'),
    who('staff', 'Staff only', 'Lecturers and admins only; hidden from students’ searches'));
  // New rooms: lecture halls and labs default to staff only.
  type.addEventListener('change', () => {
    if (editing) return;
    $(`input[value="${['lecture_hall', 'lab'].includes(type.value) ? 'staff' : 'all'}"]`, whoGroup).checked = true;
  });
  const fac = facilityPicker(v.facilities);
  const errors = errorBox();
  const confirmBox = h('div', { class: 'clash', hidden: true, role: 'alert' });

  const form = h('form', { class: 'form', novalidate: true },
    field('Building', building),
    h('div', { class: 'field-row' }, field('Room code', code, 'Shown everywhere, e.g. LT-2'), field('Name', name)),
    h('div', { class: 'field-row field-row--3' }, field('Type', type), field('Seats', capacity), field('Floor', floor, '0 = ground')),
    whoGroup,
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Facilities'), fac.el),
    errors,
    h('div', { class: 'sheet__actions' },
      h('button', { class: 'button button--primary', type: 'submit' }, editing ? 'Save changes' : 'Add room'),
      h('button', { class: 'button button--secondary', type: 'button', onclick: closeSheet }, 'Cancel')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(form, '');
    const payload = {
      buildingId: Number(building.value), code: code.value, name: name.value, type: type.value,
      capacity: Number(capacity.value), floor: floor.value, facilities: fac.value(),
      bookableBy: $('input[name="bookableBy"]:checked', form)?.value,
    };
    try {
      if (editing) await api(`/admin/rooms/${room.id}`, { method: 'PATCH', body: payload });
      else await api('/admin/rooms', { method: 'POST', body: payload });
      closeSheet();
      await changed();
    } catch (err) {
      showError(form, err.message);
    }
  });

  const parts = [form];
  if (editing) {
    const setActive = async (isActive, cancelUpcoming = false) => {
      showError(form, '');
      confirmBox.hidden = true;
      try {
        await api(`/admin/rooms/${room.id}`, { method: 'PATCH', body: { isActive, cancelUpcoming } });
        closeSheet();
        await changed();
      } catch (err) {
        if (err.status === 409 && err.data.needsConfirm) {
          confirmBox.replaceChildren(
            h('p', { class: 'clash__msg' }, err.message),
            h('button', { class: 'button button--ink', type: 'button', onclick: () => setActive(false, true) },
              `Cancel ${err.data.upcoming} booking${err.data.upcoming === 1 ? '' : 's'} and deactivate`));
          confirmBox.hidden = false;
        } else {
          showError(form, err.message);
        }
      }
    };
    const status = room.is_active
      ? `Active · ${room.upcoming} upcoming booking${room.upcoming === 1 ? '' : 's'} · ${room.total_bookings} on record`
      : `Inactive · hidden from searches and the board · ${room.total_bookings} booking${room.total_bookings === 1 ? '' : 's'} on record`;
    if (room.is_active) {
      const shown = h('span', { class: 'mono door-code' }, `${room.door_code.slice(0, 3)}-${room.door_code.slice(3)}`);
      parts.push(h('section', { class: 'danger' },
        h('h3', { class: 'panel__title' }, 'Door sign'),
        h('p', { class: 'danger__status' }, 'Door code ', shown,
          '. People scan the QR code on the sign, or type this code, to check in.'),
        h('div', { class: 'sheet__actions' },
          h('a', { class: 'button button--secondary', href: `/door-signs?room=${room.id}` }, 'Print sign'),
          confirmButton('New code', 'Old sign stops working. Click again', async () => {
            try {
              const res = await api(`/admin/rooms/${room.id}/door-code`, { method: 'POST' });
              room.door_code = res.room.door_code;
              shown.textContent = `${room.door_code.slice(0, 3)}-${room.door_code.slice(3)}`;
              await changed();
            } catch (err) { showError(form, err.message); }
          }))));
    }
    if (room.is_active) {
      const date = h('input', { type: 'date', required: true, min: new Date().toISOString().slice(0, 10) });
      const start = h('input', { type: 'time', required: true, step: '1800', value: '08:00' });
      const end = h('input', { type: 'time', required: true, step: '1800', value: '09:00' });
      const reason = h('input', { maxlength: '300', required: true, placeholder: 'e.g. Projector maintenance' });
      const blockForm = h('form', { class: 'form', novalidate: true },
        h('div', { class: 'field-row field-row--3' }, field('Date', date), field('From', start), field('Until', end)),
        field('Reason', reason), errorBox(),
        h('div', { class: 'sheet__actions' }, h('button', { class: 'button button--secondary', type: 'submit' }, 'Mark unavailable')));
      blockForm.addEventListener('submit', async (e) => {
        e.preventDefault(); showError(blockForm, '');
        try {
          await api('/admin/room-blocks', { method: 'POST', body: {
            roomId: room.id, date: date.value, start: start.value, end: end.value, reason: reason.value,
          } });
          closeSheet(); await changed();
        } catch (err) { showError(blockForm, err.message); }
      });
      parts.push(h('section', { class: 'danger' },
        h('h3', { class: 'panel__title' }, 'Temporary unavailability'),
        h('p', { class: 'field__hint' }, 'Use this for maintenance, cleaning or an externally reserved period. It cannot overlap an existing booking.'),
        blockForm));
    }
    parts.push(h('section', { class: 'danger' },
      h('h3', { class: 'panel__title' }, 'Availability'),
      h('p', { class: 'danger__status' }, status),
      confirmBox,
      h('div', { class: 'sheet__actions' },
        room.is_active
          ? h('button', { class: 'button button--secondary', type: 'button', onclick: () => openClosureSheet({ rooms: r.data.rooms, roomId: room.id, rules: r.rules, onDone: load }) }, 'Close for a time…')
          : '',
        room.is_active
          ? h('button', { class: 'button button--secondary', type: 'button', onclick: () => setActive(false) }, 'Deactivate room')
          : h('button', { class: 'button button--secondary', type: 'button', onclick: () => setActive(true) }, 'Reactivate room'),
        room.total_bookings === 0
          ? confirmButton('Delete room', 'Click again to delete', async () => {
            try {
              await api(`/admin/rooms/${room.id}`, { method: 'DELETE' });
              closeSheet();
              await changed();
            } catch (err) { showError(form, err.message); }
          })
          : null),
      room.total_bookings
        ? h('p', { class: 'field__hint' }, 'Rooms with bookings on record can be deactivated but not deleted, so their history is kept.')
        : h('p', { class: 'field__hint' }, 'This room has never been booked, so it can be deleted.')));
  }

  openEditSheet(editing ? `Edit ${room.code}` : 'Add a room', ...parts);
  (editing ? name : code).focus();
}

function openBuilding(b) {
  const editing = Boolean(b);
  const code = h('input', { class: 'mono', maxlength: '12', required: true, placeholder: 'ENG', value: b?.code || '', autocapitalize: 'characters' });
  const name = h('input', { maxlength: '80', required: true, placeholder: 'Engineering Block', value: b?.name || '' });
  // Map position for the location check at check-in (optional).
  const coords = h('input', {
    class: 'mono', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 5.1036, -1.2829',
    value: b?.latitude != null ? `${b.latitude}, ${b.longitude}` : '',
  });
  const radius = h('input', { class: 'mono', type: 'number', min: '30', max: '2000', step: '10', value: String(b?.radius_m ?? 150) });
  const here = h('button', { class: 'button button--secondary', type: 'button' }, 'Use my current location');
  const hereNote = h('p', { class: 'field__hint', role: 'status' });
  here.addEventListener('click', () => {
    if (!('geolocation' in navigator)) { hereNote.textContent = 'This browser can\'t share its location. Paste the coordinates instead.'; return; }
    here.disabled = true;
    hereNote.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition((p) => {
      coords.value = `${p.coords.latitude.toFixed(6)}, ${p.coords.longitude.toFixed(6)}`;
      hereNote.textContent = `Got it (accurate to about ${Math.round(p.coords.accuracy)} m). Save to keep it.`;
      here.disabled = false;
    }, (err) => {
      hereNote.textContent = err.code === 1 ? 'Location permission was refused. Allow it in the browser, or paste the coordinates.' : 'Couldn\'t get a location. Try again outside, or paste the coordinates.';
      here.disabled = false;
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
  const location = () => {
    const raw = coords.value.trim();
    if (!raw) return { latitude: '', longitude: '' };
    const [lat, lng] = raw.split(/[,\s]+/).filter(Boolean);
    return { latitude: lat ?? '', longitude: lng ?? '' };
  };
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field-row' }, field('Code', code, 'Short, e.g. SCB'), field('Name', name)),
    h('h3', { class: 'panel__title' }, 'Location for check-in'),
    h('p', { class: 'field__hint' }, 'Check-ins more than the radius away from this point are flagged for you (never blocked). '
      + 'Stand at the building and use your location, or in Google Maps right-click the building and copy its coordinates.'),
    h('div', { class: 'field-row' }, field('Latitude, longitude', coords), field('Radius (metres)', radius, 'Default 150')),
    h('div', { class: 'sheet__actions' }, here),
    hereNote,
    errorBox(),
    h('div', { class: 'sheet__actions' },
      h('button', { class: 'button button--primary', type: 'submit' }, editing ? 'Save changes' : 'Add building'),
      h('button', { class: 'button button--secondary', type: 'button', onclick: closeSheet }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(form, '');
    try {
      const body = { code: code.value, name: name.value, ...location(), radiusM: radius.value };
      if (editing) await api(`/admin/buildings/${b.id}`, { method: 'PATCH', body });
      else await api('/admin/buildings', { method: 'POST', body });
      closeSheet();
      await changed();
    } catch (err) {
      showError(form, err.message);
    }
  });
  const parts = [form];
  if (editing) {
    parts.push(h('section', { class: 'danger' },
      h('h3', { class: 'panel__title' }, 'Delete'),
      b.room_count
        ? h('p', { class: 'field__hint' }, `${b.code} has ${b.room_count} room${b.room_count === 1 ? '' : 's'}. Delete or move them to another building first.`)
        : confirmButton('Delete building', 'Click again to delete', async () => {
          try {
            await api(`/admin/buildings/${b.id}`, { method: 'DELETE' });
            closeSheet();
            await changed();
          } catch (err) { showError(form, err.message); }
        })));
  }
  openEditSheet(editing ? `Edit ${b.code}` : 'Add a building', ...parts);
  (editing ? name : code).focus();
}

/* ---------- Wiring --------------------------------------------------------------------- */

/** Shows the page. onChange is called after any edit so other pages pick up the new rooms. */
export function showRooms({ onChange }) {
  r.onChange = onChange;
  load();
}

$('[data-rooms-search]', view).addEventListener('input', (e) => { r.search = e.target.value.trim(); if (r.data) render(); });
$('[data-rooms-building]', view).addEventListener('change', (e) => { r.buildingId = e.target.value; render(); });
$('[data-rooms-inactive]', view).addEventListener('change', (e) => { r.showInactive = e.target.checked; render(); });
$('[data-add-room]', view).addEventListener('click', () => openRoom(null, r.buildingId ? Number(r.buildingId) : undefined));
$('[data-add-building]', view).addEventListener('click', () => openBuilding(null));
