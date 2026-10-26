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
