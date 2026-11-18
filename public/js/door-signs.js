// Printable door signs: /door-signs (every room) or /door-signs?room=12 (one room). Admins only.
import { api } from './api.js';
import { $, h, showError } from './util.js';

const formatCode = (c) => `${c.slice(0, 3)}-${c.slice(3)}`;
const roomId = new URLSearchParams(location.search).get('room');

function sign(s, rules) {
  return h('article', { class: 'sign' },
    h('header', { class: 'sign__band' },
      h('img', { class: 'sign__crest sign__crest--img', src: '/media/ucc-crest.webp', alt: 'University of Cape Coast crest', width: '34', height: '39' }),
      h('span', { class: 'sign__brand' },
        h('img', { class: 'sign__logo', src: '/media/uniguide-logo-dark.svg', alt: 'UniGuide', width: '120', height: '46' }),
        h('small', {}, 'University of Cape Coast'))),
    h('p', { class: 'sign__code mono' }, s.code),
    h('p', { class: 'sign__name' }, [...new Set([s.name, s.building_name])].join(' · ') + ` · ${s.capacity} seats`),
    h('img', { class: 'sign__qr', src: `/api/admin/rooms/${s.id}/door-qr.svg?v=${s.door_code}`, alt: `QR code for ${s.code}`, width: '240', height: '240' }),
    h('p', { class: 'sign__scan' }, 'Scan to check in, or to book this room'),
    h('p', { class: 'sign__alt' }, 'No camera? On the website, open your booking, press Check in and type',
      h('span', { class: 'sign__doorcode mono' }, formatCode(s.door_code))),
    rules.release
      ? h('p', { class: 'sign__rule' }, `Check in from ${rules.earlyMinutes} minutes before your booking starts until ${rules.graceMinutes} minutes after. `
        + 'If nobody checks in by then, the room is released for others.')
      : h('p', { class: 'sign__rule' }, `Check in from ${rules.earlyMinutes} minutes before your booking starts.`),
    h('p', { class: 'sign__url mono' }, s.url.replace(/^https?:\/\//, '')));
}

async function load() {
  try {
    const { signs, checkIn } = await api(`/admin/door-signs${roomId ? `?room=${encodeURIComponent(roomId)}` : ''}`);
    $('[data-signs-title]').textContent = roomId && signs[0] ? `Door sign · ${signs[0].code}` : `Door signs · ${signs.length} rooms`;
    document.title = roomId && signs[0] ? `${signs[0].code} · Door sign · UniGuide` : 'Door signs · UniGuide';
    $('[data-signs]').replaceChildren(...signs.map((s) => sign(s, checkIn)));
  } catch (err) {
    showError(document, err.status === 401 || err.status === 403
      ? 'Only the timetable office can print door signs. Sign in at /admin first.'
      : err.message);
  }
}

$('[data-print]').addEventListener('click', () => window.print());
load();
