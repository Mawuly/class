'use strict';
// Sending email. Production uses SMTP (Gmail with an app password, Brevo, Outlook, or the
// university's server). Development prints messages to the server console instead, and tests
// collect them in `outbox`, so neither ever sends real mail.
const nodemailer = require('nodemailer');
const config = require('../config');

const outbox = [];
let transport = null;
let override; // tests only: pretend email is or isn't set up

/** 'smtp' when SMTP is set up, 'console' / 'test' off production, otherwise null (not available). */
function mode() {
  if (override !== undefined) return override;
  const m = config.mail;
  if (m.host && m.user && m.pass && m.from) return 'smtp';
  if (config.isTest) return 'test';
  if (!config.isProd) return 'console';
  return null;
}

const enabled = () => mode() !== null;

async function send({ to, subject, text, html }) {
  const how = mode();
  if (how === 'test') { outbox.push({ to, subject, text, html }); return; }
  if (how === 'console') {
    console.log(`\n[mail] (not sent: no SMTP settings in development)\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`);
    return;
  }
  if (how !== 'smtp') throw new Error('Email is not set up');
  transport ??= nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.port === 465, // 465 is TLS from the start; 587 upgrades with STARTTLS
    auth: { user: config.mail.user, pass: config.mail.pass },
  });
  await transport.sendMail({ from: config.mail.from, to, subject, text, html });
}

/** Tests only. */
function setModeForTests(value) {
  if (!config.isTest) throw new Error('setModeForTests is for tests');
  override = value;
}

module.exports = { send, enabled, mode, outbox, setModeForTests };
