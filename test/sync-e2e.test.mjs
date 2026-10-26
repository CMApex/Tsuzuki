// End-to-end: two simulated browsers syncing through a real tsuzuki-relay process.
// Builds on `cargo build` output; skipped if the relay binary isn't there.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackground } from '../extension/src/background/core.js';
import { stableStringify } from '../extension/src/core/model.js';
import { fakeBrowser, PAGE, CONTENT } from './helpers/fake-browser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = ['release', 'debug'].map((p) => join(root, 'relay/target', p, 'tsuzuki-relay')).find(existsSync);
const PASS = 'ink brush washi lantern';

let relay, relayUrl, dataDir;

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

before(async () => {
  if (!BIN) return;
  dataDir = mkdtempSync(join(tmpdir(), 'tsuzuki-relay-'));
  const port = await freePort();
  relayUrl = `http://127.0.0.1:${port}`;
  relay = spawn(BIN, [], { env: { ...process.env, TSUZUKI_BIND: `127.0.0.1:${port}`, TSUZUKI_DATA: dataDir, RUST_LOG: 'warn' }, stdio: 'inherit' });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${relayUrl}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('relay did not start');
});

after(() => {
  relay?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function device(clockStart) {
  let t = clockStart;
  const api = fakeBrowser({});
  const bg = createBackground(api, { kdfIterations: 2000, now: () => t });
  return {
    bg,
    tick: (ms) => (t += ms),
    page: (type, extra = {}) => bg.handle({ type, ...extra }, PAGE),
    content: (type, extra = {}) => bg.handle({ type, ...extra }, CONTENT),
  };
}

const V1 = 'yt:AAAAAAAAAAA';
const V2 = 'yt:BBBBBBBBBBB';

test('two devices converge through the relay', { skip: !BIN && 'build the relay first (cargo build)' }, async () => {
  // Desktop's clock is fine; the phone's clock runs 5 minutes behind.
  const desktop = device(1_700_000_000_000);
  const phone = device(1_700_000_000_000 - 5 * 60_000);

  const { vaultId, syncError } = await desktop.page('create', { passphrase: PASS, relayUrl, deviceName: 'Zen' });
  assert.equal(syncError, null);
  await desktop.content('progress', { key: V1, t: 300, dur: 1200, title: 'Long essay' });
  await desktop.content('progress', { key: V2, t: 60, dur: 900, title: 'Second' });
  await desktop.content('search', { q: 'meshtastic range test', src: 'duckduckgo' });
  await desktop.page('syncNow');

  // The relay holds only ciphertext.
  const onDisk = readdirSync(join(dataDir, 'vaults', vaultId, 'blobs')).map((f) => readFileSync(join(dataDir, 'vaults', vaultId, 'blobs', f), 'latin1')).join('');
  assert.ok(onDisk.length > 0 && !onDisk.includes('Long essay') && !onDisk.includes('meshtastic'));

  // Wrong passphrase / unknown vault are rejected before anything is stored.
  await assert.rejects(phone.page('join', { vaultId, passphrase: 'wrong wrong wrong', relayUrl }), /Wrong passphrase/);
  await assert.rejects(phone.page('join', { vaultId: 'zzzzzzzzzzzzzzzzzzzzzz', passphrase: PASS, relayUrl }), /No vault/);
  assert.equal((await phone.page('status')).configured, false);

  const joined = await phone.page('join', { vaultId, passphrase: PASS, relayUrl, deviceName: 'iPhone' });
  assert.deepEqual(joined.stats, { resume: 2, watched: 0, searches: 1 });
  // Phone opens the video the desktop was watching: resume point is there.
  assert.deepEqual(await phone.content('getResume', { key: V1 }), { t: 300, dur: 1200 });

  // Phone (with its lagging clock) keeps watching V1, finishes V2, forgets the search.
  phone.tick(60_000);
  await phone.content('progress', { key: V1, t: 640, dur: 1200 });
  await phone.content('progress', { key: V2, t: 900, dur: 900, ended: true });
  const [s] = await phone.page('list', { kind: 'searches' });
  await phone.page('forget', { kind: 'searches', key: s.key });
  await phone.page('syncNow');

  // Desktop pulls: the phone's newer actions win despite its clock being behind.
  desktop.tick(1000);
  const r = await desktop.page('syncNow');
  assert.ok(r.merged >= 3);
  assert.deepEqual(await desktop.content('getResume', { key: V1 }), { t: 640, dur: 1200 });
  assert.equal(await desktop.content('getResume', { key: V2 }), null);
  assert.equal((await desktop.page('list', { kind: 'watched' }))[0].key, V2);
  assert.equal((await desktop.page('list', { kind: 'searches' })).length, 0);

  // One more round each and both ledgers are byte-identical.
  await phone.page('syncNow');
  const a = (await desktop.page('export')).state;
  const b = (await phone.page('export')).state;
  assert.equal(stableStringify(a), stableStringify(b));

  // Nothing changed → no re-upload.
  assert.equal((await desktop.page('syncNow')).uploaded, false);
});

test('a tampered blob is reported, not merged, and does not break sync', { skip: !BIN && 'build the relay first (cargo build)' }, async () => {
  const a = device(1_800_000_000_000);
  const b = device(1_800_000_000_000);
  const { vaultId } = await a.page('create', { passphrase: PASS, relayUrl });
  await a.content('progress', { key: V1, t: 100, dur: 1000 });
  await a.page('syncNow');
  await b.page('join', { vaultId, passphrase: PASS, relayUrl });

  // Corrupt the phone's blob directly on the relay's disk.
  const bStatus = await b.page('status');
  const path = join(dataDir, 'vaults', vaultId, 'blobs', `${bStatus.cfg.deviceId}.bin`);
  const bytes = readFileSync(path);
  bytes[bytes.length - 5] ^= 0xff;
  writeFileSync(path, bytes);

  const r = await a.page('syncNow');
  assert.equal(r.errors.length, 1);
  assert.match((await a.page('status')).sync.lastError, /decrypt/);
  assert.deepEqual(await a.content('getResume', { key: V1 }), { t: 100, dur: 1000 }, 'local data intact');

  // The phone re-uploads a fresh snapshot next time it changes something; then all is well.
  await b.content('progress', { key: V2, t: 30, dur: 100 });
  await b.page('syncNow');
  const r2 = await a.page('syncNow');
  assert.equal(r2.errors.length, 0);
  assert.deepEqual(await a.content('getResume', { key: V2 }), { t: 30, dur: 100 });
});
