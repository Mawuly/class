'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.TZ = 'Africa/Accra';
const ics = require('../src/utils/ics');

test('text is escaped: backslash, semicolon, comma, newline', () => {
  assert.equal(ics.escapeText('a\\b;c,d\ne'), String.raw`a\\b\;c\,d\ne`);
});

test('long lines fold at 75 bytes and never split a UTF-8 character', () => {
  const line = `SUMMARY:${'CSC 301 · Operating Systems – '.repeat(6)}`;
  const folded = ics.fold(line);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1);
  for (const [i, p] of parts.entries()) {
    assert.ok(Buffer.byteLength(p, 'utf8') <= 75, `part ${i} is ${Buffer.byteLength(p, 'utf8')} bytes`);
    if (i > 0) assert.equal(p[0], ' ');
    assert.ok(!p.includes('�'));
  }
  assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), line); // unfolds back exactly
});

test('Accra times become UTC stamps (Ghana is UTC+0)', () => {
  assert.equal(ics.utcStamp('2026-11-16', '14:00'), '20261116T140000Z');
});

test('a calendar has CRLF line endings and one VEVENT per event', () => {
  const body = ics.calendar({
    name: 'Test, calendar',
    events: [{ uid: 'booking-1@lecture-rooms', start: { date: '2026-11-16', time: '09:00' }, end: { date: '2026-11-16', time: '11:00' },
      summary: 'CSC 301 · Operating Systems (LT-1)', location: 'LT-1, Lecture Theatre 1', description: 'Line one\nLine two', status: 'CONFIRMED', sequence: 3 }],
  });
  assert.ok(body.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(body.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(body), 'every newline is CRLF');
  assert.equal(body.match(/BEGIN:VEVENT/g).length, 1);
  assert.match(body, /X-WR-CALNAME:Test\\, calendar/);
  assert.match(body, /DTSTART:20261116T090000Z\r\nDTEND:20261116T110000Z/);
  assert.match(body, /DESCRIPTION:Line one\\nLine two/);
  assert.match(body, /SEQUENCE:3/);
});
