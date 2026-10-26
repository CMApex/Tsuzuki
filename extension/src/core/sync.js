// Sync over a zero-knowledge relay.
//
// Every device owns one slot on the relay and uploads its *entire* merged ledger
// there, encrypted. To sync, a device downloads any slots that changed since it
// last looked, merges them in, then re-uploads its own slot if anything changed.
// Because merge is a CRDT join, there are no conflicts, locks, or ordering rules,
// and the relay can be as dumb as a folder of files.

import { aad, openJSON, sealJSON, sha256Hex, DecryptError } from './crypto.js';
import { mergeInto, stableStringify } from './model.js';

export class RelayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
  }
}

export function normalizeRelayUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const url = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.local');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('relay must use https:// (plain http is only allowed for localhost / .local)');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export class RelayClient {
  constructor({ baseUrl, vaultId, authToken, registerToken = '', fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    this.base = `${baseUrl}/v1/vaults/${encodeURIComponent(vaultId)}`;
    this.authToken = authToken;
    this.registerToken = registerToken;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, headers = {} } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const h = { authorization: `Bearer ${this.authToken}`, ...headers };
      if (this.registerToken) h['x-tsuzuki-register'] = this.registerToken;
      return await this.fetch(this.base + path, { method, body, headers: h, signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      throw new RelayError(e.name === 'AbortError' ? 'relay timed out' : `relay unreachable (${e.message})`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  static async check(res, what) {
    if (res.ok || res.status === 304) return res;
    let detail = '';
    try {
      detail = (await res.json()).error || '';
    } catch {}
    const hint = {
      401: 'wrong passphrase or vault code',
      403: 'this relay requires a registration token to create new vaults',
      413: 'snapshot too large for this relay',
    }[res.status];
    throw new RelayError(`${what}: ${hint || detail || `HTTP ${res.status}`}`, res.status);
  }

  /** List device slots. Returns [] if the vault doesn't exist on the relay yet. */
  async list() {
    const res = await this.request('/blobs');
    if (res.status === 404) return [];
    await RelayClient.check(res, 'list');
    return (await res.json()).blobs || [];
  }

  async get(deviceId, ifNoneMatch) {
    const headers = ifNoneMatch ? { 'if-none-match': `"${ifNoneMatch}"` } : {};
    const res = await RelayClient.check(await this.request(`/blobs/${encodeURIComponent(deviceId)}`, { headers }), 'download');
    if (res.status === 304) return null;
    const etag = (res.headers.get('etag') || '').replace(/"/g, '') || null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), etag };
  }

  async put(deviceId, bytes) {
    const res = await RelayClient.check(
      await this.request(`/blobs/${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        body: bytes,
        headers: { 'content-type': 'application/octet-stream' },
      }),
      'upload',
    );
    return (await res.json()).etag;
  }

  async deleteDevice(deviceId) {
    const res = await this.request(`/blobs/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    if (res.status !== 404) await RelayClient.check(res, 'delete');
  }
}

/** Hash of the canonical ledger, used to skip uploads when nothing changed. */
export function stateHash(state) {
  return sha256Hex(stableStringify(state));
}

/**
 * One sync round. Mutates `state` (merging in other devices) and `meta`
 * ({ seen: {deviceId: etag}, uploadedHash }).
 *
 * Options: pullOnly skips the upload (used for quick "anything new?" checks).
 * Returns { pulled, merged, uploaded, errors: [{device, message}] }.
 */
export async function syncOnce({ relay, key, vaultId, deviceId, state, meta, pullOnly = false }) {
  meta.seen ??= {};
  const result = { pulled: 0, merged: 0, uploaded: false, errors: [] };

  const slots = await relay.list();
  let ownSlotPresent = false;

  for (const slot of slots) {
    if (slot.device === deviceId) {
      ownSlotPresent = true;
      continue;
    }
    if (meta.seen[slot.device] === slot.etag) continue;
    try {
      const blob = await relay.get(slot.device);
      if (!blob) continue;
      const remote = await openJSON(key, blob.bytes, aad({ vaultId, purpose: 'sync', deviceId: slot.device }));
      result.merged += mergeInto(state, remote);
      result.pulled++;
      meta.seen[slot.device] = blob.etag || slot.etag;
    } catch (e) {
      if (!(e instanceof DecryptError)) throw e;
      result.errors.push({ device: slot.device, message: e.message });
    }
  }

  // Forget etags for slots that no longer exist, so a re-created slot is re-read.
  const live = new Set(slots.map((s) => s.device));
  for (const dev of Object.keys(meta.seen)) if (!live.has(dev)) delete meta.seen[dev];

  if (!pullOnly) {
    const hash = await stateHash(state);
    if (hash !== meta.uploadedHash || !ownSlotPresent) {
      const sealed = await sealJSON(key, state, aad({ vaultId, purpose: 'sync', deviceId }));
      await relay.put(deviceId, sealed);
      meta.uploadedHash = hash;
      result.uploaded = true;
    }
  }
  return result;
}
