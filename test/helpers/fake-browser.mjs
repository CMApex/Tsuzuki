// SPDX-License-Identifier: AGPL-3.0-or-later
// A minimal in-memory stand-in for the parts of browser.* Tsuzuki's background uses.

function area(store = new Map()) {
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    _store: store,
    async get(keys) {
      const out = {};
      const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      for (const k of list) if (store.has(k)) out[k] = clone(store.get(k));
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, clone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
}

/**
 * @param {object} [shared] pass { local, session } maps to simulate a service-worker
 *   restart (same storage, fresh background instance).
 */
export function fakeBrowser(shared = {}) {
  const listeners = [];
  return {
    storage: {
      local: area(shared.local),
      session: shared.noSession ? undefined : area(shared.session),
    },
    runtime: {
      getURL: (p) => `moz-extension://tsuzuki-test/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: { addListener() {} },
      openOptionsPage() {},
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    _listeners: listeners,
  };
}

export const PAGE = { url: 'moz-extension://tsuzuki-test/ui/popup.html' };
export const CONTENT = { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', tab: { id: 1 } };

const SEARCH_PAGES = {
  google: 'https://www.google.com/search?q=x',
  duckduckgo: 'https://duckduckgo.com/?q=x',
  youtube: 'https://www.youtube.com/results?search_query=x',
};

/**
 * Send a message as a content script would: from a page that belongs to the
 * service in question (YouTube by default, the engine's results page for searches).
 */
export function contentCall(bg, type, extra = {}, url) {
  const msg = { type, ...extra };
  if (['progress', 'getResume', 'getMany'].includes(type) && !msg.service) msg.service = 'youtube';
  const from = url || (type === 'search' ? SEARCH_PAGES[msg.src] : CONTENT.url);
  return bg.handle(msg, { url: from, tab: { id: 1 } });
}

/** Minimal scripting + permissions APIs, for instance tests. */
export function addInstanceApis(api, granted = new Set()) {
  const registered = new Map();
  api.scripting = {
    async getRegisteredContentScripts() {
      return [...registered.values()];
    },
    async registerContentScripts(list) {
      for (const s of list) {
        if (registered.has(s.id)) throw new Error(`duplicate script id ${s.id}`);
        registered.set(s.id, s);
      }
    },
    async unregisterContentScripts({ ids }) {
      for (const id of ids) registered.delete(id);
    },
  };
  api.permissions = {
    async contains({ origins }) {
      return origins.every((o) => granted.has(o));
    },
    async request({ origins }) {
      origins.forEach((o) => granted.add(o));
      return true;
    },
    async remove({ origins }) {
      origins.forEach((o) => granted.delete(o));
      return true;
    },
  };
  return { registered, granted };
}
