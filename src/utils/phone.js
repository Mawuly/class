'use strict';
// Ghana mobile numbers. Stored as 233XXXXXXXXX (what Arkesel expects); shown as 024 123 4567.

/**
 * Accepts 0241234567, 024 123 4567, +233 24 123 4567, 233241234567 or 00233…
 * Returns 233XXXXXXXXX, or null when it isn't a Ghana mobile number.
 */
function normalizeGhana(input) {
  let d = String(input ?? '').replace(/[\s().-]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (/^0\d{9}$/.test(d)) d = `233${d.slice(1)}`;
  if (/^[25]\d{8}$/.test(d)) d = `233${d}`; // typed without the leading 0
  // Mobile numbers start 02x or 05x (MTN, Telecel, AT).
  return /^233[25]\d{8}$/.test(d) ? d : null;
}

/** 233241234567 → 024 123 4567 */
function displayPhone(p) {
  if (!p) return null;
  const local = `0${p.slice(3)}`;
  return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}

/** 233241234567 → 024 ••• 4567 (what a stranger may see) */
function maskPhone(p) {
  if (!p) return null;
  const local = `0${p.slice(3)}`;
  return `${local.slice(0, 3)} ••• ${local.slice(6)}`;
}

module.exports = { normalizeGhana, displayPhone, maskPhone };
