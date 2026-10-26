// SPDX-License-Identifier: AGPL-3.0-or-later
// Tsuzuki ledger model.
//
// The whole ledger is three maps of last-writer-wins (LWW) registers:
//
//   resume   "yt:<videoId>" -> { at, dev, t, dur, title?, ch? }   where you stopped
//   watched  "yt:<videoId>" -> { at, dev, title?, ch? }           things you finished
//   searches "<random id>"  -> { at, dev, q, src }                 queries you typed
//
// Any record may instead be a tombstone { at, dev, del: true } ("forget this").
//
// Merging two ledgers is a per-key max under the order (at, dev, content), which
// makes merge commutative, associative and idempotent. That is the entire sync
// story: devices can exchange snapshots in any order, any number of times, and
// they always converge. A replayed or stale snapshot can never undo newer data.

import { compileQuery, matchScore, prepareText } from './search.js';

// Normalised search text per record object. Records are replaced, never mutated, so this stays valid.
const searchText = new WeakMap();

export const SCHEMA_VERSION = 1;
export const KINDS = Object.freeze(['resume', 'watched', 'searches']);

/** Don't bother remembering a resume point earlier than this (seconds). */
export const MIN_RESUME_SECONDS = 15;
/** Treat a video as finished once this fraction has been played... */
export const WATCHED_FRACTION = 0.9;
/** ...or once fewer than this many seconds remain (end cards, outros). */
export const END_GUARD_SECONDS = 25;
/** Identical searches from the same engine within this window are one search. */
export const SEARCH_DEDUPE_MS = 10 * 60 * 1000;

const MAX_TITLE = 300;
const MAX_QUERY = 500;
const MAX_KEY = 128;

export function emptyState() {
  return { v: SCHEMA_VERSION, resume: {}, watched: {}, searches: {} };
}

// ---------------------------------------------------------------------------
// Ordering & merge
// ---------------------------------------------------------------------------

/** Deterministic JSON (sorted keys) so ties and hashes are stable everywhere. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** Total order on records: does `a` beat `b`? */
export function beats(a, b) {
  if (!b) return !!a;
  if (!a) return false;
  if (a.at !== b.at) return a.at > b.at;
  if (a.dev !== b.dev) return a.dev > b.dev;
  return stableStringify(a) > stableStringify(b);
}

/**
 * Merge `incoming` into `target` in place. Incoming records are sanitized first,
 * so a corrupt or hostile snapshot can't inject junk. Returns how many records
 * changed in `target`.
 */
export function mergeInto(target, incoming) {
  let changed = 0;
  if (!incoming || typeof incoming !== 'object') return 0;
  for (const kind of KINDS) {
    const src = incoming[kind];
    if (!src || typeof src !== 'object') continue;
    const dst = (target[kind] ??= {});
    for (const key of Object.keys(src)) {
      if (!validKey(key)) continue;
      const rec = sanitizeRecord(kind, src[key]);
      if (!rec) continue;
      if (beats(rec, dst[key])) {
        dst[key] = rec;
        changed++;
      }
    }
  }
  return changed;
}

/** Pure merge: returns a new state containing the winner of every key. */
export function merge(a, b) {
  const out = emptyState();
  mergeInto(out, a);
  mergeInto(out, b);
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY && key !== '__proto__';
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export function sanitizeRecord(kind, rec) {
  if (!rec || typeof rec !== 'object') return null;
  const at = num(rec.at);
  const dev = str(rec.dev, 64);
  if (at === undefined || !dev) return null;
  if (rec.del === true) return { at, dev, del: true };

  if (kind === 'resume') {
    const t = num(rec.t);
    const dur = num(rec.dur);
    if (t === undefined || dur === undefined) return null;
    return dropUndefined({ at, dev, t: round1(t), dur: round1(dur), title: str(rec.title, MAX_TITLE), ch: str(rec.ch, MAX_TITLE) });
  }
  if (kind === 'watched') {
    return dropUndefined({ at, dev, title: str(rec.title, MAX_TITLE), ch: str(rec.ch, MAX_TITLE) });
  }
  if (kind === 'searches') {
    const q = str(rec.q, MAX_QUERY);
    const src = str(rec.src, 32);
    if (!q || !src) return null;
    return { at, dev, q, src };
  }
  return null;
}

function dropUndefined(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '') delete o[k];
  return o;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Local operations
// ---------------------------------------------------------------------------

/**
 * Timestamp for a local write that must supersede `existing`. Normally wall-clock
 * time, but never earlier than what we've already seen, so a device whose clock
 * runs behind another's can still overwrite (or forget) a record it has seen.
 */
export function nextAt(existing, now) {
  return existing && existing.at >= now ? existing.at + 1 : now;
}

function put(state, kind, key, fields, now, dev) {
  const existing = state[kind][key];
  const rec = sanitizeRecord(kind, { ...fields, at: nextAt(existing, now), dev });
  if (!rec) return false;
  state[kind][key] = rec;
  return true;
}

export function isLive(rec) {
  return !!rec && rec.del !== true;
}

/**
 * Record playback progress. Decides between "remember where I am" and
 * "I finished this". Returns { changed, finished }.
 */
export function recordProgress(state, { key, t, dur, title, ch, ended = false }, now, dev) {
  if (!validKey(key) || !(dur > 0) || !(t >= 0)) return { changed: false, finished: false };
  const finished = ended || t / dur >= WATCHED_FRACTION || dur - t <= END_GUARD_SECONDS;
  const meta = { title, ch };

  if (finished) {
    let changed = false;
    if (!isLive(state.watched[key])) {
      changed = put(state, 'watched', key, meta, now, dev) || changed;
    }
    if (isLive(state.resume[key])) {
      changed = put(state, 'resume', key, { del: true }, now, dev) || changed;
    }
    return { changed, finished: true };
  }

  if (t < MIN_RESUME_SECONDS) return { changed: false, finished: false };

  const prev = state.resume[key];
  // Skip no-op writes (paused & re-reported at the same spot).
  if (isLive(prev) && Math.abs(prev.t - t) < 1 && prev.title === (title || prev.title)) {
    return { changed: false, finished: false };
  }
  // Keep the old title/channel if this tick didn't have them yet (SPA timing).
  const merged = {
    t,
    dur,
    title: title || (isLive(prev) ? prev.title : undefined),
    ch: ch || (isLive(prev) ? prev.ch : undefined),
  };
  return { changed: put(state, 'resume', key, merged, now, dev), finished: false };
}

/** Record a search, de-duplicating repeats of the same query. Returns the id or null. */
export function recordSearch(state, { q, src }, now, dev, newId) {
  const query = typeof q === 'string' ? q.trim().replace(/\s+/g, ' ') : '';
  if (!query || !src) return null;
  for (const [id, rec] of Object.entries(state.searches)) {
    if (isLive(rec) && rec.src === src && rec.q === query && now - rec.at < SEARCH_DEDUPE_MS) {
      return null;
    }
  }
  const id = newId();
  put(state, 'searches', id, { q: query, src }, now, dev);
  return id;
}

/** Forget a record (tombstone). Returns true if something live was forgotten. */
export function forget(state, kind, key, now, dev) {
  if (!KINDS.includes(kind) || !validKey(key)) return false;
  if (!isLive(state[kind][key])) return false;
  return put(state, kind, key, { del: true }, now, dev);
}

/** Live entries of a kind, newest first, optionally filtered by a text query. */
/**
 * Live entries of a kind. Without a query: newest first. With one: fuzzy-matched
 * (see search.js) and ranked by match quality, then recency.
 */
export function listLive(state, kind, { query = '', limit = 200 } = {}) {
  const q = compileQuery(query);
  const out = [];
  for (const [key, rec] of Object.entries(state[kind] || {})) {
    if (!isLive(rec)) continue;
    let prepared = null;
    if (!q.empty) {
      prepared = searchText.get(rec);
      if (!prepared) searchText.set(rec, (prepared = prepareText(`${rec.title || ''} ${rec.ch || ''} ${rec.q || ''} ${key}`)));
    }
    const score = q.empty ? 1 : matchScore(q, prepared);
    if (!score) continue;
    out.push({ key, ...rec, _score: score });
  }
  out.sort((a, b) => b._score - a._score || b.at - a.at);
  return out.slice(0, limit).map(({ _score, ...e }) => e);
}

export function stats(state) {
  const count = (kind) => Object.values(state[kind] || {}).filter(isLive).length;
  return { resume: count('resume'), watched: count('watched'), searches: count('searches') };
}

/** Progress summary for a batch of item keys (used for thumbnail bars). */
export function progressFor(state, keys) {
  const out = {};
  for (const key of keys) {
    const r = state.resume[key];
    const w = state.watched[key];
    const resumeLive = isLive(r);
    const watchedLive = isLive(w);
    // If both exist, whichever is newer describes the latest viewing.
    if (resumeLive && (!watchedLive || r.at > w.at)) {
      out[key] = { p: Math.min(1, r.dur > 0 ? r.t / r.dur : 0), w: watchedLive };
    } else if (watchedLive) {
      out[key] = { p: 1, w: true };
    }
  }
  return out;
}
