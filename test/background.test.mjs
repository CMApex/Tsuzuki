// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackground } from '../extension/src/background/core.js';
import { fakeBrowser, PAGE, CONTENT } from './helpers/fake-browser.mjs';

const PASS = 'paper lantern river stone';
const KDF = { kdfIterations: 2000 };

function setup(shared, opts = {}) {
  let t = opts.start ?? 1_700_000_000_000;
  const api = fakeBrowser(shared);
  const bg = createBackground(api, { ...KDF, now: () => t, ...opts });
  const page = (type, extra = {}) => bg.handle({ type, ...extra }, PAGE);
  const content = (type, extra = {}) => bg.handle({ type, ...extra }, CONTENT);
  return { api, bg, page, content, tick: (ms) => (t += ms), now: () => t };
}

const watch = (t, extra = {}) => ({ key: 'yt:dQw4w9WgXcQ', t, dur: 600, title: 'Never gonna', ch: 'Rick', ...extra });

test('unconfigured: nothing is recorded, privileged calls are refused to content scripts', async () => {
  const { page, content } = setup({});
  assert.equal((await page('status')).configured, false);
  assert.deepEqual(await content('progress', watch(120)), { ok: false, reason: 'not-configured' });
  for (const type of ['export', 'list', 'status', 'wipe', 'unlock', 'create', 'settings']) {
    await assert.rejects(content(type), /not allowed/, type);
  }
  await assert.rejects(page('nonsense'), /unknown message/);
});

test('create → record → resume → badges; ledger is encrypted at rest', async () => {
  const local = new Map();
  const { bg, page, content, tick } = setup({ local });
  await assert.rejects(page('create', { passphrase: 'short' }), /at least 12/);

  const { vaultId } = await page('create', { passphrase: PASS, deviceName: 'Zen on Windows' });
  assert.match(vaultId, /^[A-Za-z0-9_-]{22}$/);
  const st = await page('status');
  assert.equal(st.unlocked, true);
  assert.equal(st.cfg.deviceName, 'Zen on Windows');

  await content('progress', watch(120));
  tick(10_000);
  await content('progress', watch(130));
  assert.deepEqual(await content('getResume', { key: 'yt:dQw4w9WgXcQ' }), { t: 130, dur: 600 });
  const badges = await content('getMany', { keys: ['yt:dQw4w9WgXcQ', 'yt:AAAAAAAAAAA'] });
  assert.deepEqual(Object.keys(badges), ['yt:dQw4w9WgXcQ']);

  await content('search', { q: 'shiori bookmark', src: 'google' });
  const searches = await page('list', { kind: 'searches' });
  assert.equal(searches[0].q, 'shiori bookmark');

  await bg.flush();
  const raw = JSON.stringify([...local.entries()]);
  assert.ok(!raw.includes('Never gonna'), 'titles are not stored in plaintext');
  assert.ok(!raw.includes('shiori'), 'searches are not stored in plaintext');

  // Finishing turns the resume point into a watched entry.
  await content('progress', watch(600, { ended: true }));
  assert.equal(await content('getResume', { key: 'yt:dQw4w9WgXcQ' }), null);
  assert.equal((await page('list', { kind: 'watched' }))[0].title, 'Never gonna');
});

test('lock queues events in session memory; unlock applies them; wrong passphrase fails', async () => {
  const local = new Map();
  const session = new Map();
  const { page, content } = setup({ local, session });
  await page('create', { passphrase: PASS });
  await page('lock');

  assert.equal(await content('getResume', { key: 'yt:dQw4w9WgXcQ' }), null);
  assert.deepEqual(await content('progress', watch(200)), { ok: true, queued: true });
  assert.equal((await page('status')).pending, 1);
  await assert.rejects(page('list', { kind: 'resume' }), /locked/);
  assert.ok(!JSON.stringify([...local.entries()]).includes('Never gonna'), 'queue never touches disk');

  await assert.rejects(page('unlock', { passphrase: 'not the passphrase' }), /Wrong passphrase/);
  await page('unlock', { passphrase: PASS });
  const resume = await page('list', { kind: 'resume' });
  assert.equal(resume.length, 1);
  assert.equal(resume[0].t, 200);
  assert.equal((await page('status')).pending, 0);
});

test('service-worker restart stays unlocked; browser restart locks', async () => {
  const local = new Map();
  const session = new Map();
  const first = setup({ local, session });
  await first.page('create', { passphrase: PASS });
  await first.content('progress', watch(321));
  await first.bg.flush();

  // Worker killed and restarted (Safari does this constantly): same storage, new instance.
  const second = setup({ local, session });
  assert.equal((await second.page('status')).unlocked, true);
  assert.equal((await second.content('getResume', { key: 'yt:dQw4w9WgXcQ' })).t, 321);

  // Browser quit: session storage is gone.
  const third = setup({ local, session: new Map() });
  assert.equal((await third.page('status')).unlocked, false);
  await third.page('unlock', { passphrase: PASS });
  assert.equal((await third.content('getResume', { key: 'yt:dQw4w9WgXcQ' })).t, 321);
});

test('works without storage.session (keys held in worker memory)', async () => {
  const { page, content } = setup({ noSession: true });
  await page('create', { passphrase: PASS });
  await content('progress', watch(99));
  assert.equal((await content('getResume', { key: 'yt:dQw4w9WgXcQ' })).t, 99);
  await page('lock');
  await content('progress', watch(150));
  await page('unlock', { passphrase: PASS });
  assert.equal((await content('getResume', { key: 'yt:dQw4w9WgXcQ' })).t, 150);
});

test('feature toggles are respected', async () => {
  const { page, content } = setup({});
  await page('create', { passphrase: PASS });
  await page('settings', { features: { searches: false, badges: false, bogus: true } });
  const f = await content('features');
  assert.equal(f.searches, false);
  assert.equal(f.bogus, undefined);
  await content('search', { q: 'should not be kept', src: 'google' });
  assert.equal((await page('list', { kind: 'searches' })).length, 0);
  await content('progress', watch(100));
  assert.deepEqual(await content('getMany', { keys: ['yt:dQw4w9WgXcQ'] }), {});

  await page('settings', { features: { recording: false } });
  await content('progress', watch(300));
  assert.equal((await page('list', { kind: 'resume' }))[0].t, 100, 'recording off freezes the ledger');
});

test('forget, export, import into another vault, wipe', async () => {
  const a = setup({});
  await a.page('create', { passphrase: PASS });
  await a.content('progress', watch(100));
  await a.content('progress', { key: 'yt:BBBBBBBBBBB', t: 50, dur: 300 });
  assert.equal((await a.page('forget', { kind: 'resume', key: 'yt:BBBBBBBBBBB' })).ok, true);
  assert.deepEqual((await a.page('list', { kind: 'resume' })).map((e) => e.key), ['yt:dQw4w9WgXcQ']);

  const exported = await a.page('export');
  assert.equal(exported.format, 'tsuzuki-ledger');

  const b = setup({});
  await b.page('create', { passphrase: 'a completely different one' });
  assert.ok((await b.page('import', { data: JSON.parse(JSON.stringify(exported)) })).merged >= 2);
  assert.deepEqual((await b.page('list', { kind: 'resume' })).map((e) => e.key), ['yt:dQw4w9WgXcQ']);
  assert.equal((await b.page('import', { data: exported })).merged, 0, 'import is idempotent');

  await a.page('wipe');
  const st = await a.page('status');
  assert.equal(st.configured, false);
  assert.equal(st.unlocked, false);
  assert.equal(a.api.storage.local._store.size, 0);
});
