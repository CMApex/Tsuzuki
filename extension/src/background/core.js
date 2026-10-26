// Tsuzuki background logic. Written against an injected `api` (the browser.*
// namespace) so it runs unchanged in Firefox, Safari, and Node tests.
//
// Storage layout
//   storage.local    tsz:cfg     vault id, device id, relay settings, feature toggles (no secrets)
//                    tsz:state   the ledger, AES-GCM sealed (purpose "local")
//                    tsz:sync    relay bookkeeping (etags seen, last upload hash, last error)
//   storage.session  tsz:keys    derived key material while unlocked (memory only, gone on browser quit)
//                    tsz:pending events captured while locked, applied on unlock

import {
  KDF_ITERATIONS, aad, deriveVaultSecrets, importEncKey, openJSON, randomId, sealJSON, fromB64url, toB64url,
} from '../core/crypto.js';
import {
  KINDS, emptyState, forget, listLive, mergeInto, progressFor, recordProgress, recordSearch, stats,
} from '../core/model.js';
import { RelayClient, RelayError, normalizeRelayUrl, syncOnce } from '../core/sync.js';

const K = { cfg: 'tsz:cfg', state: 'tsz:state', sync: 'tsz:sync', keys: 'tsz:keys', pending: 'tsz:pending' };

export const MIN_PASSPHRASE = 12;
const VAULT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const PENDING_CAP = 1000;
const PERIODIC_SYNC_MINUTES = 15;
const SYNC_AFTER_CHANGE_MS = 20_000;
const FRESH_PULL_MS = 45_000;
const RESUME_PULL_TIMEOUT_MS = 2500;
const ALARM = 'tsz-sync';

export const DEFAULT_FEATURES = Object.freeze({ recording: true, resume: true, badges: true, searches: true });
const CONTENT_SCRIPT_TYPES = new Set(['progress', 'search', 'getResume', 'getMany', 'features']);

export class UserError extends Error {}

export function createBackground(api, opts = {}) {
  const now = opts.now || (() => Date.now());
  const iterations = opts.kdfIterations || KDF_ITERATIONS;
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
  const local = api.storage.local;
  const session = api.storage.session || null; // Older Safari: fall back to worker memory.

  let cfg = null; // persisted config
  let vault = null; // { key, authToken, state } while unlocked
  let memKeys = null;
  let memPending = [];
  let loading = null;
  let writeChain = Promise.resolve();
  let persistTimer = null;
  let syncTimer = null;
  let syncing = null;

  // ---------------------------------------------------------------- storage

  async function getLocal(key) {
    return (await local.get(key))[key];
  }

  async function getKeys() {
    if (!session) return memKeys;
    return (await session.get(K.keys))[K.keys] || null;
  }
  async function setKeys(keys) {
    if (!session) memKeys = keys;
    else if (keys) await session.set({ [K.keys]: keys });
    else await session.remove(K.keys);
  }

  async function getPending() {
    if (!session) return memPending;
    return (await session.get(K.pending))[K.pending] || [];
  }
  async function setPending(list) {
    if (!session) memPending = list;
    else if (list.length) await session.set({ [K.pending]: list });
    else await session.remove(K.pending);
  }

  const localAad = () => aad({ vaultId: cfg.vaultId, purpose: 'local', deviceId: cfg.deviceId });

  async function sealState(key, state) {
    return toB64url(await sealJSON(key, state, localAad()));
  }

  async function openState(key) {
    const sealed = await getLocal(K.state);
    if (!sealed) return emptyState();
    return openJSON(key, fromB64url(sealed), localAad());
  }

  function persistSoon(delay = 400) {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => void persistNow(), delay);
    persistTimer.unref?.(); // Node tests: don't hold the process open
  }

  function persistNow() {
    clearTimeout(persistTimer);
    persistTimer = null;
    if (!vault) return writeChain;
    const { key, state } = vault;
    writeChain = writeChain
      .then(async () => local.set({ [K.state]: await sealState(key, state) }))
      .catch((e) => console.error('[tsuzuki] persist failed', e));
    return writeChain;
  }

  async function saveCfg(next) {
    cfg = next;
    await local.set({ [K.cfg]: cfg });
  }

  async function getSyncMeta() {
    return (await getLocal(K.sync)) || { seen: {} };
  }

  // ---------------------------------------------------------------- lifecycle

  /** Load config and, if this browser session already unlocked the vault, the ledger. */
  function ensureLoaded() {
    loading ??= (async () => {
      cfg = (await getLocal(K.cfg)) || null;
      if (!cfg || vault) return;
      const keys = await getKeys();
      if (!keys) return;
      try {
        const key = await importEncKey(keys.encKeyRaw);
        vault = { key, authToken: keys.authToken, state: await openState(key) };
        await drainPending();
      } catch (e) {
        console.warn('[tsuzuki] stored session key no longer opens the ledger; locking', e);
        await setKeys(null);
      }
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  async function openVault(secrets) {
    const key = await importEncKey(secrets.encKeyRaw);
    vault = { key, authToken: secrets.authToken, state: null };
    return key;
  }

  async function drainPending() {
    const pending = await getPending();
    if (!pending.length || !vault) return;
    let changed = false;
    for (const op of pending) changed = applyEvent(op, op.at) || changed;
    await setPending([]);
    if (changed) {
      persistSoon();
      scheduleSync();
    }
  }

  function features() {
    return { ...DEFAULT_FEATURES, ...(cfg?.features || {}) };
  }

  // ---------------------------------------------------------------- events

  /** Apply a captured browsing event. Returns true if the ledger changed. */
  function applyEvent(ev, at) {
    const f = features();
    if (!f.recording) return false;
    const dev = cfg.deviceId;
    if (ev.type === 'progress') {
      if (!f.resume && !ev.ended) return false;
      return recordProgress(vault.state, ev, at, dev).changed;
    }
    if (ev.type === 'search') {
      if (!f.searches) return false;
      return recordSearch(vault.state, ev, at, dev, () => randomId(9)) !== null;
    }
    return false;
  }

  async function captureEvent(ev) {
    if (!cfg) return { ok: false, reason: 'not-configured' };
    const at = now();
    if (!vault) {
      const pending = await getPending();
      pending.push({ ...ev, at });
      await setPending(pending.slice(-PENDING_CAP));
      return { ok: true, queued: true };
    }
    if (applyEvent(ev, at)) {
      persistSoon();
      scheduleSync();
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- sync

  function relayClient(over = {}) {
    const c = { ...cfg, ...over };
    return new RelayClient({
      baseUrl: c.relayUrl,
      vaultId: c.vaultId,
      authToken: over.authToken || vault.authToken,
      registerToken: c.registerToken || '',
      fetchImpl,
    });
  }

  function scheduleSync(delay = SYNC_AFTER_CHANGE_MS) {
    if (!cfg?.relayUrl) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => void runSync().catch(() => {}), delay);
    syncTimer.unref?.();
  }

  /** Run one sync round (deduplicated if one is already in flight). */
  function runSync({ pullOnly = false } = {}) {
    if (syncing) return syncing;
    syncing = (async () => {
      if (!cfg?.relayUrl || !vault) return { skipped: true };
      const meta = await getSyncMeta();
      try {
        const result = await syncOnce({
          relay: relayClient(),
          key: vault.key,
          vaultId: cfg.vaultId,
          deviceId: cfg.deviceId,
          state: vault.state,
          meta,
          pullOnly,
        });
        if (result.merged) await persistNow();
        meta.lastPullAt = now();
        if (!pullOnly) meta.lastSyncAt = now();
        meta.lastError = result.errors.length
          ? `couldn't decrypt ${result.errors.length} device snapshot(s): ${result.errors[0].message}`
          : null;
        meta.lastResult = { pulled: result.pulled, merged: result.merged, uploaded: result.uploaded };
        return result;
      } catch (e) {
        meta.lastError = e.message;
        meta.lastErrorAt = now();
        throw e;
      } finally {
        await local.set({ [K.sync]: meta });
      }
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  async function freshPull() {
    if (!cfg?.relayUrl || !vault) return;
    const meta = await getSyncMeta();
    if (now() - (meta.lastPullAt || 0) < FRESH_PULL_MS) return;
    await Promise.race([
      runSync({ pullOnly: true }).catch(() => {}),
      new Promise((r) => setTimeout(r, RESUME_PULL_TIMEOUT_MS).unref?.()),
    ]);
  }

  // ---------------------------------------------------------------- setup

  function checkPassphrase(p) {
    if (typeof p !== 'string' || p.length < MIN_PASSPHRASE) {
      throw new UserError(`Passphrase must be at least ${MIN_PASSPHRASE} characters. A few random words works well.`);
    }
  }

  async function createVault({ passphrase, deviceName, relayUrl, registerToken }) {
    if (cfg) throw new UserError('This browser already has a vault. Wipe it first to create a new one.');
    checkPassphrase(passphrase);
    const relay = relayUrl ? normalizeRelayUrl(relayUrl) : '';
    const vaultId = randomId(16);
    const secrets = await deriveVaultSecrets(passphrase, vaultId, iterations);
    await saveCfg({
      v: 1,
      vaultId,
      deviceId: randomId(12),
      deviceName: (deviceName || 'This device').slice(0, 60),
      relayUrl: relay,
      registerToken: registerToken || '',
      iterations,
      createdAt: now(),
      features: { ...DEFAULT_FEATURES },
    });
    const key = await openVault(secrets);
    vault.state = emptyState();
    await setKeys(secrets);
    await local.set({ [K.state]: await sealState(key, vault.state), [K.sync]: { seen: {} } });
    let syncError = null;
    if (relay) await runSync().catch((e) => (syncError = e.message));
    return { vaultId, syncError };
  }

  async function joinVault({ vaultId, passphrase, deviceName, relayUrl, registerToken }) {
    if (cfg) throw new UserError('This browser already has a vault. Wipe it first to join another.');
    const id = String(vaultId || '').trim();
    if (!VAULT_ID.test(id)) throw new UserError("That doesn't look like a vault code.");
    if (!relayUrl) throw new UserError('Joining a vault needs the relay URL your other device uses.');
    const relay = normalizeRelayUrl(relayUrl);
    if (!passphrase) throw new UserError('Enter the vault passphrase.');

    const secrets = await deriveVaultSecrets(passphrase, id, iterations);
    const key = await importEncKey(secrets.encKeyRaw);
    const deviceId = randomId(12);
    const client = new RelayClient({ baseUrl: relay, vaultId: id, authToken: secrets.authToken, registerToken, fetchImpl });

    let slots;
    try {
      slots = await client.list();
    } catch (e) {
      if (e instanceof RelayError && e.status === 401) throw new UserError('Wrong passphrase for that vault.');
      throw e;
    }
    if (!slots.length) throw new UserError('No vault with that code exists on this relay.');

    const state = emptyState();
    const meta = { seen: {} };
    const result = await syncOnce({ relay: client, key, vaultId: id, deviceId, state, meta });
    if (result.pulled === 0 && result.errors.length) {
      throw new UserError(`Joined the relay, but couldn't decrypt its data (${result.errors[0].message}).`);
    }

    await saveCfg({
      v: 1,
      vaultId: id,
      deviceId,
      deviceName: (deviceName || 'This device').slice(0, 60),
      relayUrl: relay,
      registerToken: registerToken || '',
      iterations,
      createdAt: now(),
      features: { ...DEFAULT_FEATURES },
    });
    vault = { key, authToken: secrets.authToken, state };
    await setKeys(secrets);
    meta.lastSyncAt = meta.lastPullAt = now();
    meta.lastResult = { pulled: result.pulled, merged: result.merged, uploaded: result.uploaded };
    await local.set({ [K.state]: await sealState(key, state), [K.sync]: meta });
    return { stats: stats(state) };
  }

  async function unlock({ passphrase }) {
    if (!cfg) throw new UserError('No vault set up yet.');
    if (vault) return { ok: true };
    const secrets = await deriveVaultSecrets(passphrase || '', cfg.vaultId, cfg.iterations || iterations);
    const key = await importEncKey(secrets.encKeyRaw);
    let state;
    try {
      state = await openState(key);
    } catch {
      throw new UserError('Wrong passphrase.');
    }
    vault = { key, authToken: secrets.authToken, state };
    await setKeys(secrets);
    await drainPending();
    void runSync().catch(() => {});
    return { ok: true };
  }

  async function lock() {
    await persistNow();
    vault = null;
    await setKeys(null);
    return { ok: true };
  }

  async function wipe({ alsoRelay = false } = {}) {
    let relayError = null;
    if (alsoRelay && vault && cfg?.relayUrl) {
      try {
        await relayClient().deleteDevice(cfg.deviceId);
      } catch (e) {
        relayError = e.message;
      }
    }
    clearTimeout(persistTimer);
    clearTimeout(syncTimer);
    await writeChain;
    vault = null;
    cfg = null;
    await setKeys(null);
    await setPending([]);
    await local.remove([K.cfg, K.state, K.sync]);
    return { ok: true, relayError };
  }

  // ---------------------------------------------------------------- queries

  async function status() {
    const meta = cfg ? await getSyncMeta() : null;
    return {
      configured: !!cfg,
      unlocked: !!vault,
      pending: cfg && !vault ? (await getPending()).length : 0,
      cfg: cfg && {
        vaultId: cfg.vaultId,
        deviceId: cfg.deviceId,
        deviceName: cfg.deviceName,
        relayUrl: cfg.relayUrl,
        hasRegisterToken: !!cfg.registerToken,
        features: features(),
      },
      stats: vault ? stats(vault.state) : null,
      sync: meta && {
        lastSyncAt: meta.lastSyncAt || null,
        lastError: meta.lastError || null,
        lastResult: meta.lastResult || null,
        devices: Object.keys(meta.seen || {}).length,
      },
    };
  }

  function requireUnlocked() {
    if (!vault) throw new UserError('Vault is locked.');
  }

  // ---------------------------------------------------------------- dispatch

  const handlers = {
    // Content scripts
    features: async () => ({ ...features(), unlocked: !!vault }),
    progress: (m) => captureEvent({ type: 'progress', key: m.key, t: m.t, dur: m.dur, title: m.title, ch: m.ch, ended: !!m.ended }),
    search: (m) => captureEvent({ type: 'search', q: m.q, src: m.src }),
    getResume: async (m) => {
      if (!vault || !features().resume) return null;
      await freshPull();
      const rec = vault?.state.resume[m.key];
      return rec && !rec.del ? { t: rec.t, dur: rec.dur } : null;
    },
    getMany: async (m) => {
      if (!vault || !features().badges || !Array.isArray(m.keys)) return {};
      return progressFor(vault.state, m.keys.slice(0, 500));
    },

    // Extension pages only
    status: () => status(),
    create: (m) => createVault(m),
    join: (m) => joinVault(m),
    unlock: (m) => unlock(m),
    lock: () => lock(),
    list: async (m) => {
      requireUnlocked();
      if (!KINDS.includes(m.kind)) throw new UserError('unknown list');
      return listLive(vault.state, m.kind, { query: m.query || '', limit: Math.min(m.limit || 200, 2000) });
    },
    forget: async (m) => {
      requireUnlocked();
      const changed = forget(vault.state, m.kind, m.key, now(), cfg.deviceId);
      if (changed) {
        await persistNow();
        scheduleSync(2000);
      }
      return { ok: changed };
    },
    settings: async (m) => {
      if (!cfg) throw new UserError('No vault set up yet.');
      const next = { ...cfg };
      if (m.features) next.features = { ...features(), ...pick(m.features, Object.keys(DEFAULT_FEATURES)) };
      if (typeof m.deviceName === 'string') next.deviceName = m.deviceName.slice(0, 60) || cfg.deviceName;
      if (typeof m.relayUrl === 'string') {
        const relay = m.relayUrl ? normalizeRelayUrl(m.relayUrl) : '';
        if (relay !== cfg.relayUrl) await local.set({ [K.sync]: { seen: {} } });
        next.relayUrl = relay;
      }
      if (typeof m.registerToken === 'string') next.registerToken = m.registerToken;
      await saveCfg(next);
      return status();
    },
    syncNow: async () => {
      requireUnlocked();
      if (!cfg.relayUrl) throw new UserError('Set a relay URL in Settings to sync.');
      return runSync();
    },
    export: async () => {
      requireUnlocked();
      return { format: 'tsuzuki-ledger', v: 1, exportedAt: now(), vaultId: cfg.vaultId, state: vault.state };
    },
    import: async (m) => {
      requireUnlocked();
      const incoming = m.data?.format === 'tsuzuki-ledger' ? m.data.state : m.data;
      const merged = mergeInto(vault.state, incoming);
      if (merged) {
        await persistNow();
        scheduleSync(2000);
      }
      return { merged };
    },
    wipe: (m) => wipe(m),
  };

  async function handle(msg, sender = {}) {
    if (!msg || typeof msg.type !== 'string' || !Object.hasOwn(handlers, msg.type)) {
      throw new UserError('unknown message');
    }
    const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(api.runtime.getURL(''));
    if (!fromExtensionPage && !CONTENT_SCRIPT_TYPES.has(msg.type)) throw new UserError('not allowed');
    await ensureLoaded();
    return handlers[msg.type](msg);
  }

  // ---------------------------------------------------------------- wiring

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handle(msg, sender).then(
      (result) => sendResponse({ ok: true, result: result ?? null }),
      (err) => {
        if (!(err instanceof UserError)) console.error('[tsuzuki]', err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      },
    );
    return true; // keep the channel open for the async response (Chrome/Safari/Firefox)
  });

  if (api.alarms) {
    api.alarms.create(ALARM, { periodInMinutes: PERIODIC_SYNC_MINUTES });
    api.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== ALARM) return;
      ensureLoaded().then(() => runSync().catch(() => {}));
    });
  }

  api.runtime.onInstalled?.addListener((details) => {
    if (details?.reason === 'install') api.runtime.openOptionsPage?.();
  });

  return { handle, ensureLoaded, flush: () => persistNow(), runSync };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (typeof obj[k] === 'boolean') out[k] = obj[k];
  return out;
}
