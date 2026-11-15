'use strict';
// "Continue with Google". Google's token endpoint is replaced by a stub that returns the ID token
// each test chooses; everything else (state, PKCE, cookies, accounts) runs for real.
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

const { test, before, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { db, agent, signedIn, resetDb, PASSWORD } = require('./helpers');

before(resetDb);
after(() => db.pool.end());

const realFetch = global.fetch;
let tokenCalls = [];
let claims = null;
global.fetch = async (url, opts) => {
  if (String(url) !== 'https://oauth2.googleapis.com/token') return realFetch(url, opts);
  tokenCalls.push(Object.fromEntries(new URLSearchParams(String(opts.body))));
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return new Response(JSON.stringify({ id_token: `${part({ alg: 'RS256' })}.${part(claims)}.sig` }), { status: 200 });
};

/** Clicks "Continue with Google", "picks" an account, and follows Google's redirect back. */
async function viaGoogle(a, identity, { next = '/', tamperState = false } = {}) {
  const start = await a.raw.get(`/api/auth/google/start?next=${encodeURIComponent(next)}`);
  assert.equal(start.status, 302);
  const url = new URL(start.headers.location);
  claims = {
    iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300,
    nonce: url.searchParams.get('nonce'), email_verified: true, ...identity,
  };
  const state = tamperState ? 'x'.repeat(url.searchParams.get('state').length) : url.searchParams.get('state');
  return a.raw.get(`/api/auth/google/callback?code=abc&state=${state}`);
}

describe('Continue with Google', () => {
  beforeEach(async () => { await resetDb(); tokenCalls = []; });

  test('the button is offered, and Google is asked with PKCE, a state and a nonce', async () => {
    assert.equal((await agent().get('/api/auth/options')).body.google, true);
    const res = await agent().raw.get('/api/auth/google/start?next=/admin');
    const url = new URL(res.headers.location);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
    assert.match(url.searchParams.get('redirect_uri'), /\/api\/auth\/google\/callback$/);
    assert.equal(url.searchParams.get('scope'), 'openid email profile');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    for (const k of ['state', 'nonce', 'code_challenge']) assert.ok(url.searchParams.get(k).length >= 40);
    assert.match(res.headers['set-cookie'][0], /g_oauth=.*HttpOnly/i);
  });

  test('a new person gets a student account and is signed in, then sent back', async () => {
    const a = agent();
    const res = await viaGoogle(a, { sub: 'g-1', email: 'Esi.Owusu@Campus.test', name: 'Esi Owusu' }, { next: '/door?c=K7P2QX' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/door?c=K7P2QX');
    const me = (await a.get('/api/auth/me')).body.user;
    assert.deepEqual([me.name, me.email, me.role], ['Esi Owusu', 'esi.owusu@campus.test', 'student']);
    assert.equal(tokenCalls[0].code, 'abc');
    assert.ok(tokenCalls[0].code_verifier.length >= 40);
    // Signing in again with the same Google account finds the same person.
    const again = agent();
    await viaGoogle(again, { sub: 'g-1', email: 'esi.owusu@campus.test', name: 'Esi' });
    assert.equal((await again.get('/api/auth/me')).body.user.id, me.id);
    const log = (await db.all("SELECT action, details FROM audit_log WHERE user_id = ? ORDER BY id", [me.id])).map((r) => `${r.action}:${r.details?.via}`);
    assert.deepEqual(log, ['auth.register:google', 'auth.login:google', 'auth.login:google']);
  });

  test('an existing account is linked; its old password and other sessions stop working', async () => {
    const old = await signedIn('kofi@campus.test');
    const a = agent();
    await viaGoogle(a, { sub: 'g-2', email: 'kofi@campus.test', name: 'Kofi A.' });
    assert.equal((await a.get('/api/auth/me')).body.user.id, old.user.id);
    assert.equal((await old.get('/api/auth/me')).status, 401, 'the session from before is signed out');
    const pw = await agent().post('/api/auth/login').send({ email: 'kofi@campus.test', password: PASSWORD });
    assert.equal(pw.status, 401);
    const notes = (await a.get('/api/notifications')).body.notifications;
    assert.match(notes[0].message, /old password no longer works/);
  });

  test('ADMIN_EMAILS still decides who is an admin', async () => {
    const a = agent();
    await viaGoogle(a, { sub: 'g-3', email: 'boss@campus.test', name: 'The Boss' }, { next: '/admin' });
    assert.equal((await a.get('/api/auth/me')).body.user.role, 'admin');
  });

  test('refused: unverified email, wrong state, a deactivated account, another Google account', async () => {
    let res = await viaGoogle(agent(), { sub: 'g-4', email: 'x@campus.test', email_verified: false });
    assert.match(decodeURIComponent(res.headers.location), /auth_error=Your Google account email is not verified/);

    res = await viaGoogle(agent(), { sub: 'g-5', email: 'y@campus.test' }, { tamperState: true });
    assert.match(decodeURIComponent(res.headers.location), /could not be verified/);
    assert.equal(tokenCalls.length, 1, 'no code exchange with a bad state');

    const kofi = await signedIn('kofi@campus.test');
    await db.run('UPDATE users SET is_active = false WHERE id = ?', [kofi.user.id]);
    res = await viaGoogle(agent(), { sub: 'g-6', email: 'kofi@campus.test' });
    assert.match(decodeURIComponent(res.headers.location), /deactivated/);

    const a = agent();
    await viaGoogle(a, { sub: 'g-7', email: 'ama@campus.test', name: 'Ama' });
    res = await viaGoogle(agent(), { sub: 'g-8', email: 'ama@campus.test', name: 'Ama' });
    assert.match(decodeURIComponent(res.headers.location), /different Google account/);
  });

  test('without the cookie from step 1, or a foreign "next", nothing happens', async () => {
    const res = await agent().raw.get('/api/auth/google/callback?code=abc&state=zzz');
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.location), /^\/\?auth_error=Google sign-in took too long/);
    const evil = await agent().raw.get('/api/auth/google/start?next=https://evil.example');
    const back = await agent().raw.get('/api/auth/google/start?next=//evil.example');
    for (const r of [evil, back]) {
      const cookie = r.headers['set-cookie'][0].split(';')[0].split('=')[1];
      const payload = JSON.parse(Buffer.from(cookie.split('.')[1], 'base64url').toString());
      assert.equal(payload.next, '/');
    }
  });
});
