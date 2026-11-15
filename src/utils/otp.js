'use strict';
// One-time codes, shared by password reset and phone verification.
const crypto = require('crypto');
const config = require('../config');

/** 6 random digits. */
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** "482913" → "482 913" */
const spaced = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

/**
 * An HMAC keyed with the server secret, with the purpose mixed in: a copy of the database alone
 * can't be used to try codes offline, and a code for one purpose can't be used for another.
 */
const keyed = (purpose, code) => crypto.createHmac('sha256', config.jwtSecret).update(`${purpose}:${code}`).digest('hex');

/** Constant-time comparison of two hex digests. */
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Digits only, so "482 913" and "482-913" work too. */
const digits = (v) => String(v ?? '').replace(/\D/g, '');

module.exports = { newCode, spaced, keyed, sameHash, digits };
