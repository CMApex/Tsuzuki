// SPDX-License-Identifier: AGPL-3.0-or-later
// Tsuzuki background logic. Written against an injected `api` (the browser.*
// namespace) so it runs unchanged in Firefox, Safari, and Node tests.
//
// Storage layout
//   storage.local    tsz:cfg     vault id, device id, relay settings, feature + service toggles,
//                                user-added instances (no secrets)
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
import {
  INSTANCE_TYPES, SERVICES, VIDEO, instancePattern, normalizeInstanceUrl, resolveServices, searchServiceBySrc,
  serviceById,
} from '../core/services.js';
import { toUrl } from '../core/parse.js';
import { THEME_IDS, checkCustomCss, normalizeAppearance } from '../core/theme.js';

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
/** Home page preferences. Thumbnails are off by default: loading them tells the video site what you've watched. */
export const DEFAULT_HOME = Object.freeze({ thumbs: false, engine: 'duckduckgo' });
const CONTENT_SCRIPT_TYPES = new Set(['progress', 'search', 'getResume', 'getMany', 'features', 'instance']);
const INSTANCE_SCRIPT_PREFIX = 'tsz-inst-';
const MAX_INSTANCES = 32;

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
  let scriptsSynced = false;

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
      if (!scriptsSynced) {
        scriptsSynced = true;
        await syncInstanceScriptsQuietly();
      }
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

  function services() {
    return resolveServices(cfg?.services);
  }

  function homePrefs() {
    return { ...DEFAULT_HOME, ...(cfg?.home || {}) };
  }

  // ---------------------------------------------------------------- who may record what
  //
  // Every event from a content script is checked against the page that sent it:
  // the service must be switched on, the sending page must belong to that
  // service, and the key must be in that service's namespace. A script running
  // on one site can't write history for another.

  function instanceForUrl(url) {
    return url && (cfg?.instances || []).find((i) => i.origin === url.origin) || null;
  }

  /** The key prefix this sender may read/write for videos, or null if it may not. */
  function videoScope(msg, sender) {
    const url = toUrl(sender.url);
    if (!url || !cfg) return null;
    if (msg.service === 'instance') {
      const inst = instanceForUrl(url);
      const type = inst && INSTANCE_TYPES[inst.type];
      return inst?.enabled && type?.video ? type.keyPrefix(url.host) : null;
    }
    const svc = serviceById(msg.service);
    if (!svc || svc.kind !== VIDEO || !services()[svc.id] || !svc.host.test(url.hostname)) return null;
    return svc.keyPrefix;
  }

  function searchAllowed(src, sender) {
    const url = toUrl(sender.url);
    if (!url || !cfg || typeof src !== 'string') return false;
    const svc = searchServiceBySrc(src);
    if (svc) return services()[svc.id] && svc.host.test(url.hostname);
    const inst = instanceForUrl(url);
    return !!inst?.enabled && src === `${inst.type}:${url.host}`;
  }

  // ---------------------------------------------------------------- instances (Firefox)
  //
  // Self-hosted services live on domains we can't know in advance, so their
  // content script is registered at runtime, only for origins the user added
  // and granted access to. Needs scripting.registerContentScripts and optional
  // host permissions; browsers without them simply don't offer instances.

  const instancesSupported = () => !!(api.scripting?.registerContentScripts && api.permissions?.contains);

  async function syncInstanceScripts() {
    if (!instancesSupported()) return;
    const registered = await api.scripting.getRegisteredContentScripts();
    const ours = registered.filter((r) => r.id.startsWith(INSTANCE_SCRIPT_PREFIX)).map((r) => r.id);
    if (ours.length) await api.scripting.unregisterContentScripts({ ids: ours });
    const wanted = [];
    for (const inst of cfg?.instances || []) {
      if (!inst.enabled) continue;
      const pattern = instancePattern(inst.origin);
      if (!(await api.permissions.contains({ origins: [pattern] }))) continue;
      wanted.push({
        id: INSTANCE_SCRIPT_PREFIX + inst.origin.replace(/[^a-z0-9]/gi, '-'),
        matches: [pattern],
        js: ['content/instance.js'],
        runAt: 'document_end',
        persistAcrossSessions: true,
      });
    }
    if (wanted.length) await api.scripting.registerContentScripts(wanted);
  }

  function syncInstanceScriptsQuietly() {
    return syncInstanceScripts().catch((e) => console.warn('[tsuzuki] instance scripts', e));
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
    await syncInstanceScriptsQuietly();
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
        services: services(),
        instances: cfg.instances || [],
        home: homePrefs(),
        appearance: normalizeAppearance(cfg.appearance),
      },
      instancesSupported: instancesSupported(),
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
    features: async () => ({ ...features(), unlocked: !!vault, services: services() }),
    instance: async (m, sender) => {
      const inst = instanceForUrl(toUrl(sender.url));
      return inst ? { type: inst.type, enabled: inst.enabled, features: { ...features(), unlocked: !!vault } } : null;
    },
    progress: (m, sender) => {
      if (!cfg) return { ok: false, reason: 'not-configured' };
      const prefix = videoScope(m, sender);
      if (!prefix || typeof m.key !== 'string' || !m.key.startsWith(prefix)) return { ok: false, reason: 'not-allowed' };
      return captureEvent({ type: 'progress', key: m.key, t: m.t, dur: m.dur, title: m.title, ch: m.ch, ended: !!m.ended });
    },
    search: (m, sender) => {
      if (!cfg) return { ok: false, reason: 'not-configured' };
      if (!searchAllowed(m.src, sender)) return { ok: false, reason: 'not-allowed' };
      return captureEvent({ type: 'search', q: m.q, src: m.src });
    },
    getResume: async (m, sender) => {
      const prefix = videoScope(m, sender);
      if (!vault || !features().resume || !prefix || !String(m.key).startsWith(prefix)) return null;
      await freshPull();
      const rec = vault?.state.resume[m.key];
      return rec && !rec.del ? { t: rec.t, dur: rec.dur } : null;
    },
    getMany: async (m, sender) => {
      const prefix = videoScope(m, sender);
      if (!vault || !features().badges || !prefix || !Array.isArray(m.keys)) return {};
      return progressFor(vault.state, m.keys.slice(0, 500).filter((k) => typeof k === 'string' && k.startsWith(prefix)));
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
      if (m.services) next.services = { ...services(), ...pick(m.services, SERVICES.map((x) => x.id)) };
      if (m.appearance) {
        const next_ = { ...normalizeAppearance(cfg.appearance) };
        if (m.appearance.theme !== undefined) {
          if (!THEME_IDS.includes(m.appearance.theme)) throw new UserError('Unknown theme.');
          next_.theme = m.appearance.theme;
        }
        if (m.appearance.customCss !== undefined) {
          const problem = checkCustomCss(m.appearance.customCss);
          if (problem) throw new UserError(problem);
          next_.customCss = m.appearance.customCss;
        }
        next.appearance = next_;
      }
      if (m.home) {
        next.home = { ...homePrefs(), ...pick(m.home, ['thumbs']) };
        if (typeof m.home.engine === 'string' && m.home.engine.length <= 100) next.home.engine = m.home.engine;
      }
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
    addInstance: async (m) => {
      if (!cfg) throw new UserError('No vault set up yet.');
      if (!instancesSupported()) throw new UserError("This browser can't run Tsuzuki on custom sites yet.");
      if (!INSTANCE_TYPES[m.instanceType]) throw new UserError('Unknown instance type.');
      let parsed;
      try {
        parsed = normalizeInstanceUrl(m.url);
      } catch (e) {
        throw new UserError(e.message);
      }
      const list = (cfg.instances || []).filter((i) => i.origin !== parsed.origin);
      if (list.length >= MAX_INSTANCES) throw new UserError(`At most ${MAX_INSTANCES} instances.`);
      if (!(await api.permissions.contains({ origins: [parsed.pattern] }))) {
        throw new UserError(`Tsuzuki needs permission to run on ${parsed.host}.`);
      }
      list.push({ origin: parsed.origin, type: m.instanceType, enabled: true, addedAt: now() });
      await saveCfg({ ...cfg, instances: list });
      await syncInstanceScriptsQuietly();
      return status();
    },
    setInstance: async (m) => {
      if (!cfg) throw new UserError('No vault set up yet.');
      const list = (cfg.instances || []).map((i) => (i.origin === m.origin ? { ...i, enabled: !!m.enabled } : i));
      await saveCfg({ ...cfg, instances: list });
      await syncInstanceScriptsQuietly();
      return status();
    },
    removeInstance: async (m) => {
      if (!cfg) throw new UserError('No vault set up yet.');
      const inst = (cfg.instances || []).find((i) => i.origin === m.origin);
      if (!inst) return status();
      await saveCfg({ ...cfg, instances: cfg.instances.filter((i) => i !== inst) });
      await syncInstanceScriptsQuietly();
      try {
        await api.permissions?.remove?.({ origins: [instancePattern(inst.origin)] });
      } catch {}
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
    return handlers[msg.type](msg, sender);
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

  api.commands?.onCommand?.addListener((command) => {
    if (command === 'open-home') api.tabs?.create({ url: api.runtime.getURL('ui/home.html') });
  });

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
