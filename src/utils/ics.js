'use strict';
// A small iCalendar (RFC 5545) writer: just what booking calendars need.

/** Escapes TEXT values: backslash, semicolon, comma and newlines. */
function escapeText(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Folds a content line at 75 octets (RFC 5545 §3.1), never splitting a UTF-8 character:
 * "–" and "·" are three bytes each and appear in titles here.
 */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Step back over UTF-8 continuation bytes (10xxxxxx) so a character stays whole.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines start with a space, which counts
  }
  return parts.join('\r\n ');
}

/** 20261116T140000Z from a local (Africa/Accra) date and HH:MM time. */
function utcStamp(date, time) {
  return new Date(`${date}T${time}:00`).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const nowStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * Builds a calendar. events: [{ uid, start: {date, time}, end: {date, time}, summary, location,
 * description, status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED', sequence, url }]
 */
function calendar({ name, events, refreshHours = 1 }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lecture Room Booking System//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-WR-TIMEZONE:Africa/Accra',
    // Hints for subscribed calendars: check again every hour.
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refreshHours}H`,
    `X-PUBLISHED-TTL:PT${refreshHours}H`,
  ];
  const stamp = nowStamp();
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utcStamp(e.start.date, e.start.time)}`,
      `DTEND:${utcStamp(e.end.date, e.end.time)}`,
      `SUMMARY:${escapeText(e.summary)}`,
      `LOCATION:${escapeText(e.location)}`,
      `DESCRIPTION:${escapeText(e.description)}`,
      `STATUS:${e.status}`,
      `SEQUENCE:${e.sequence ?? 0}`,
      'TRANSP:OPAQUE',
    );
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { calendar, escapeText, fold, utcStamp };
