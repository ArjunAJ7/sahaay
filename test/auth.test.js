// Auth & role negative tests: session enforcement, passcode checks,
// cross-profile isolation, duplicate-dose protection, archive disclaimer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8390;
const BASE = `http://127.0.0.1:${PORT}`;
let child, dir;

// Minimal cookie-aware fetch wrapper (no external deps).
function client() {
  let cookie = '';
  return async function call(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    let body = opts.body;
    if (body && typeof body === 'object') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(body).toString();
    }
    const res = await fetch(BASE + path, { ...opts, headers, body, redirect: 'manual' });
    const setC = res.headers.get('set-cookie');
    if (setC) cookie = setC.split(';')[0];
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get('location') };
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sahaay-auth-'));
  child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  // Wait for the server to accept connections.
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

after(() => { child?.kill(); rmSync(dir, { recursive: true, force: true }); });

test('dashboard requires a session', async () => {
  const r = await client()('/app');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/');
});

test('joining with a wrong passcode is rejected', async () => {
  const c = client();
  const create = await c('/profiles', { method: 'POST', body: {
    elder_name: 'Test Elder A', name: 'Owner A', role: 'family', email: 'a@example.com', passcode: '2468',
  } });
  assert.equal(create.status, 302); // created + logged in
  const dash = await c('/app');
  const code = dash.text.match(/Profile code:\s*<[^>]*>\s*([A-Z0-9]{6})/)?.[1];
  assert.ok(code, 'profile code visible on dashboard');

  const intruder = client();
  const bad = await intruder('/join', { method: 'POST', body: {
    code, passcode: '9999', name: 'Intruder', role: 'family', email: 'i@example.com',
  } });
  assert.equal(bad.status, 403);
  const dashAfter = await intruder('/app');
  assert.equal(dashAfter.status, 302); // still no session
});

test('a member of profile A cannot act on profile B doses', async () => {
  const a = client();
  await a('/profiles', { method: 'POST', body: {
    elder_name: 'Elder A', name: 'Member A', role: 'family', email: 'ma@example.com', passcode: '1111',
  } });
  const b = client();
  await b('/profiles', { method: 'POST', body: {
    elder_name: 'Elder B', name: 'Member B', role: 'caretaker', email: 'mb@example.com', passcode: '2222',
  } });
  // B adds a medication with an explicit dose time.
  const add = await b('/app/meds', { method: 'POST', body: {
    name: 'TestMedB', dosage: '5mg', instructions: '', time1: '23:59', start_date: '2026-11-15', confirmed: '1',
  } });
  assert.equal(add.status, 302);
  const bMeds = await b('/app/meds');
  const doseId = bMeds.text.match(/doses\/(\d+)\/taken/)?.[1]
    || (await b('/app')).text.match(/doses\/(\d+)\/taken/)?.[1];
  assert.ok(doseId, 'B has a markable dose');
  // A tries to mark B's dose - must not affect it.
  await a(`/app/doses/${doseId}/taken`, { method: 'POST' });
  const bDash = await b('/app');
  assert.ok(!bDash.text.includes('Marked by Member A'), 'B dose untouched by A');
});

test('double-marking a dose records a single taken event', async () => {
  const c = client();
  await c('/profiles', { method: 'POST', body: {
    elder_name: 'Elder C', name: 'Member C', role: 'family', email: 'mc@example.com', passcode: '3333',
  } });
  await c('/app/meds', { method: 'POST', body: { name: 'TestMedC', dosage: '10mg', instructions: '', time1: '23:58', start_date: '2026-11-15', confirmed: '1' } });
  const dash = await c('/app');
  const doseId = dash.text.match(/doses\/(\d+)\/taken/)?.[1];
  assert.ok(doseId);
  // Fire two marks in parallel (race) plus a sequential third.
  await Promise.all([
    c(`/app/doses/${doseId}/taken`, { method: 'POST' }),
    c(`/app/doses/${doseId}/taken`, { method: 'POST' }),
  ]);
  await c(`/app/doses/${doseId}/taken`, { method: 'POST' });
  const after = await c('/app');
  const marks = after.text.match(/TestMedC \(23:58\) as taken/g) || [];
  assert.equal(marks.length, 1, 'exactly one taken activity recorded');
});

test('archive page warns it never means stopping treatment', async () => {
  const c = client();
  await c('/profiles', { method: 'POST', body: {
    elder_name: 'Elder D', name: 'Member D', role: 'family', email: 'md@example.com', passcode: '4444',
  } });
  await c('/app/meds', { method: 'POST', body: { name: 'TestMedD', dosage: '1 tab', instructions: '', time1: '08:00', start_date: '2026-11-15', confirmed: '1' } });
  const meds = await c('/app/meds');
  const m = meds.text.match(/\/app\/meds\/(\d+)\/archive/);
  assert.ok(m, 'archive link present');
  const page = await c(`/app/meds/${m[1]}/archive`);
  assert.equal(page.status, 200);
  assert.match(page.text, /reminders/i);
  assert.match(page.text, /doctor says so|never stop|do not stop/i);
});

test('repeated failed joins are rate-limited with 429', async () => {
  const c = client();
  const create = await c('/profiles', { method: 'POST', body: {
    elder_name: 'Test Elder R', name: 'Owner R', role: 'family', email: 'r@example.com', passcode: '1357',
  } });
  assert.equal(create.status, 302);
  const dash = await c('/app');
  const code = dash.text.match(/Profile code:\s*<[^>]*>\s*([A-Z0-9]{6})/)?.[1];
  assert.ok(code);

  const brute = client();
  let limited = false;
  for (let i = 0; i < 15 && !limited; i++) {
    const r = await brute('/join', { method: 'POST', body: {
      code, passcode: '0000', name: 'Brute', role: 'family', email: 'b@example.com',
    } });
    if (r.status === 429) limited = true;
    else assert.equal(r.status, 403);
  }
  assert.ok(limited, 'join attempts eventually rate-limited');
});
