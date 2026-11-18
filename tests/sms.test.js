'use strict';
process.env.NODE_ENV = 'test';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const sms = require('../src/services/sms');

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  sms.setModeForTests(undefined);
  Object.assign(config.sms, { apiKey: '', sender: '', sandbox: false });
});

function arkesel(reply = { status: 'success', data: [{ recipient: '233241234567', id: 'abc' }] }, httpStatus = 200) {
  Object.assign(config.sms, { apiKey: 'test-key', sender: 'LectRooms' });
  sms.setModeForTests('arkesel');
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: httpStatus < 400, status: httpStatus, json: async () => reply };
  };
  return calls;
}

test('sends one Arkesel v2 request: api-key header, sender, message, recipients', async () => {
  const calls = arkesel();
  await sms.send('233241234567', 'UniGuide: your code is 482 913.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sms.arkesel.com/api/v2/sms/send');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['api-key'], 'test-key');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, { sender: 'LectRooms', message: 'UniGuide: your code is 482 913.', recipients: ['233241234567'] });
});

test('ARKESEL_SANDBOX adds sandbox: true', async () => {
  const calls = arkesel();
  config.sms.sandbox = true;
  await sms.send('233241234567', 'hi');
  assert.equal(calls[0].body.sandbox, true);
});

test("Arkesel's refusal is reported with its own words", async () => {
  arkesel({ status: 'error', message: 'Invalid sender ID' }, 422);
  await assert.rejects(sms.send('233241234567', 'hi'), /Arkesel refused the message \(HTTP 422\): Invalid sender ID/);
});

test('a 200 without status "success" is still a failure', async () => {
  arkesel({ status: 'error', message: 'Insufficient balance' }, 200);
  await assert.rejects(sms.send('233241234567', 'hi'), /Insufficient balance/);
});

test('network failures surface as errors', async () => {
  arkesel();
  global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND sms.arkesel.com'); };
  await assert.rejects(sms.send('233241234567', 'hi'), /ENOTFOUND/);
});
