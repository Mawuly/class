'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../src/utils/time');

test('overlap: bookings that touch end-to-start do not clash', () => {
  assert.equal(t.overlaps('08:00', '10:00', '10:00', '12:00'), false);
  assert.equal(t.overlaps('10:00', '12:00', '08:00', '10:00'), false);
});

test('overlap: partial, contained and identical ranges clash', () => {
  assert.equal(t.overlaps('08:00', '10:00', '09:30', '11:00'), true);
  assert.equal(t.overlaps('08:00', '12:00', '09:00', '10:00'), true);
  assert.equal(t.overlaps('09:00', '10:00', '08:00', '12:00'), true);
  assert.equal(t.overlaps('09:00', '10:00', '09:00', '10:00'), true);
});

test('overlap: separate ranges do not clash', () => {
  assert.equal(t.overlaps('08:00', '09:00', '13:00', '14:00'), false);
});

// Fixed "now": Friday 13 Nov 2026, 09:15 local time.
const NOW = new Date(2026, 10, 13, 9, 15);
const slot = (date, start, end) => t.validateSlot({ date, start, end }, NOW);

test('validateSlot accepts a normal future slot', () => {
  assert.equal(slot('2026-11-14', '08:30', '10:30'), null);
  assert.equal(slot('2026-11-13', '09:30', '10:00'), null);
});

test('validateSlot rejects malformed input', () => {
  assert.match(slot('2026-02-30', '08:00', '09:00'), /valid date/);
  assert.match(slot('14/11/2026', '08:00', '09:00'), /valid date/);
  assert.match(slot('2026-11-14', '8:00', '09:00'), /HH:MM/);
  assert.match(slot('2026-11-14', '24:00', '09:00'), /HH:MM/);
});

test('validateSlot enforces 30-minute boundaries', () => {
  assert.match(slot('2026-11-14', '08:15', '09:00'), /30-minute/);
});

test('validateSlot enforces opening hours 07:00–21:00', () => {
  assert.match(slot('2026-11-14', '06:30', '08:00'), /between 07:00 and 21:00/);
  assert.match(slot('2026-11-14', '20:00', '21:30'), /between 07:00 and 21:00/);
  assert.equal(slot('2026-11-14', '07:00', '08:00'), null);
  assert.equal(slot('2026-11-14', '20:00', '21:00'), null);
});

test('validateSlot rejects end before start and zero length', () => {
  assert.match(slot('2026-11-14', '10:00', '09:00'), /after start/);
  assert.match(slot('2026-11-14', '10:00', '10:00'), /after start/);
});

test('validateSlot caps a booking at 6 hours', () => {
  assert.equal(slot('2026-11-14', '08:00', '14:00'), null);
  assert.match(slot('2026-11-14', '08:00', '14:30'), /at most 6 hours/);
});

test('validateSlot rejects the past', () => {
  assert.match(slot('2026-11-12', '10:00', '11:00'), /past/);
  assert.match(slot('2026-11-13', '09:00', '10:00'), /past/);
});

test('validateSlot limits how far ahead you can book', () => {
  assert.equal(slot(t.addDays('2026-11-13', 150), '08:00', '09:00'), null);
  assert.match(slot(t.addDays('2026-11-13', 151), '08:00', '09:00'), /150 days ahead/);
});
