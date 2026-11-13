'use strict';
const { booking } = require('../config');

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

function toMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(n) {
  return `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
}

/** Two half-open intervals [aStart, aEnd) and [bStart, bEnd) clash. Touching ends do not. */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function isValidTime(t) {
  return typeof t === 'string' && TIME_RE.test(t);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/**
 * Checks a requested slot against the booking rules.
 * Returns an error message, or null when the slot is acceptable.
 */
function validateSlot({ date, start, end }, now = new Date()) {
  const { open, close, slotMinutes, maxHours, maxDaysAhead } = booking;
  if (!isValidDate(date)) return 'Date must be a valid date (YYYY-MM-DD)';
  if (!isValidTime(start) || !isValidTime(end)) return 'Times must be in HH:MM format';

  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s % slotMinutes || e % slotMinutes) return `Times must be on ${slotMinutes}-minute boundaries`;
  if (e <= s) return 'End time must be after start time';
  if (s < toMinutes(open) || e > toMinutes(close)) return `Rooms can be booked between ${open} and ${close}`;
  if (e - s > maxHours * 60) return `A booking can last at most ${maxHours} hours`;

  const today = localDate(now);
  if (date < today || (date === today && start < localTime(now))) return 'You cannot book a time in the past';
  if (daysBetween(today, date) > maxDaysAhead) return `Bookings can be made at most ${maxDaysAhead} days ahead`;
  return null;
}

module.exports = {
  toMinutes, fromMinutes, overlaps, isValidTime, isValidDate,
  localDate, localTime, addDays, daysBetween, validateSlot,
};
