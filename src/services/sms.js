'use strict';
// Text messages through Arkesel's SMS API (v2). Everything Arkesel-specific is in this file.
//
//   POST {ARKESEL_URL}           default https://sms.arkesel.com/api/v2/sms/send
//   header  api-key: {ARKESEL_API_KEY}
//   body    { sender, message, recipients: ["233XXXXXXXXX"], sandbox? }
//   success { "status": "success", ... }
//
// Development prints messages in the terminal and tests collect them in `outbox`; neither sends.
const config = require('../config');

const outbox = [];
let override; // tests only

function mode() {
  if (override !== undefined) return override;
  if (config.sms.apiKey && config.sms.sender) return 'arkesel';
  if (config.isTest) return 'test';
  if (!config.isProd) return 'console';
  return null;
}

const enabled = () => mode() !== null;

/** Sends one message. Keep it in plain GSM characters and under 160 so it's one SMS. */
async function send(to, message) {
  const how = mode();
  if (how === 'test') { outbox.push({ to, message }); return; }
  if (how === 'console') {
    console.log(`\n[sms] (not sent: no Arkesel settings in development)\nTo: +${to}\n${message}\n`);
    return;
  }
  if (how !== 'arkesel') throw new Error('Text messages are not set up');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // stay well inside Vercel's 10 s
  let res;
  let body;
  try {
    res = await fetch(config.sms.url, {
      method: 'POST',
      headers: { 'api-key': config.sms.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: config.sms.sender,
        message,
        recipients: [to],
        ...(config.sms.sandbox ? { sandbox: true } : {}),
      }),
      signal: controller.signal,
    });
    body = await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || body.status !== 'success') {
    // Arkesel's own words help when setting it up (wrong key, sender ID not approved, no credit).
    throw new Error(`Arkesel refused the message (HTTP ${res.status}): ${String(body.message || body.status || 'no details').slice(0, 160)}`);
  }
}

/** Tests only. */
function setModeForTests(value) {
  if (!config.isTest) throw new Error('setModeForTests is for tests');
  override = value;
}

module.exports = { send, enabled, mode, outbox, setModeForTests };
