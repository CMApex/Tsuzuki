import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveVaultSecrets, importEncKey, sealJSON, openJSON, aad, DecryptError, toB64url, fromB64url, randomId,
} from '../extension/src/core/crypto.js';

const ITER = 2000; // fast for tests; production uses 600k

test('b64url round-trips arbitrary bytes', () => {
  for (let len = 0; len < 70; len++) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    assert.deepEqual(fromB64url(toB64url(bytes)), bytes);
  }
  assert.match(randomId(16), /^[A-Za-z0-9_-]{22}$/);
  assert.match(randomId(12), /^[A-Za-z0-9_-]{16}$/);
});

test('same passphrase + vault → same keys; anything else differs', async () => {
  const a = await deriveVaultSecrets('correct horse battery staple', 'vaultAAAAAAAAAAAAAAAAA', ITER);
  const b = await deriveVaultSecrets('correct horse battery staple', 'vaultAAAAAAAAAAAAAAAAA', ITER);
  const c = await deriveVaultSecrets('correct horse battery stapl3', 'vaultAAAAAAAAAAAAAAAAA', ITER);
  const d = await deriveVaultSecrets('correct horse battery staple', 'vaultBBBBBBBBBBBBBBBBBB', ITER);
  assert.deepEqual(a, b);
  assert.notEqual(a.encKeyRaw, c.encKeyRaw);
  assert.notEqual(a.encKeyRaw, d.encKeyRaw);
  assert.notEqual(a.authToken, a.encKeyRaw, 'relay token is independent of the encryption key');
});

test('unicode passphrases are normalized', async () => {
  const composed = await deriveVaultSecrets('café au lait!', 'vaultAAAAAAAAAAAAAAAAA', ITER);
  const decomposed = await deriveVaultSecrets('café au lait!', 'vaultAAAAAAAAAAAAAAAAA', ITER);
  assert.equal(composed.encKeyRaw, decomposed.encKeyRaw);
});

test('envelopes round-trip and reject wrong key, wrong context and tampering', async () => {
  const s1 = await deriveVaultSecrets('passphrase number one', 'vaultAAAAAAAAAAAAAAAAA', ITER);
  const s2 = await deriveVaultSecrets('passphrase number two', 'vaultAAAAAAAAAAAAAAAAA', ITER);
  const k1 = await importEncKey(s1.encKeyRaw);
  const k2 = await importEncKey(s2.encKeyRaw);
  const ctx = aad({ vaultId: 'v', purpose: 'sync', deviceId: 'deviceA' });
  const value = { resume: { 'yt:x': { at: 1, dev: 'A', t: 10, dur: 20 } }, note: '続き' };

  const env = await sealJSON(k1, value, ctx);
  assert.deepEqual(await openJSON(k1, env, ctx), value);

  await assert.rejects(openJSON(k2, env, ctx), DecryptError, 'wrong key');
  await assert.rejects(openJSON(k1, env, aad({ vaultId: 'v', purpose: 'sync', deviceId: 'deviceB' })), DecryptError, 'slot swap');
  await assert.rejects(openJSON(k1, env, aad({ vaultId: 'v', purpose: 'local', deviceId: 'deviceA' })), DecryptError, 'purpose swap');

  for (const i of [0, 3, 10, env.length - 1]) {
    const bad = env.slice();
    bad[i] ^= 1;
    await assert.rejects(openJSON(k1, bad, ctx), DecryptError, `flipped byte ${i}`);
  }
  await assert.rejects(openJSON(k1, env.slice(0, 20), ctx), DecryptError, 'truncated');

  const env2 = await sealJSON(k1, value, ctx);
  assert.notDeepEqual(env, env2, 'fresh IV every time');
});
