import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, merge, mergeInto, recordProgress, recordSearch, forget, listLive, progressFor,
  stableStringify, nextAt, sanitizeRecord,
} from '../extension/src/core/model.js';

const canon = (s) => stableStringify(s);
let n = 0;
const ids = () => `id${++n}`;

test('progress: early positions are not remembered', () => {
  const s = emptyState();
  assert.equal(recordProgress(s, { key: 'yt:a', t: 5, dur: 600 }, 1000, 'A').changed, false);
  assert.deepEqual(s.resume, {});
});

test('progress: mid-video becomes a resume point; near the end becomes watched', () => {
  const s = emptyState();
  recordProgress(s, { key: 'yt:a', t: 120, dur: 600, title: 'Tea ceremony' }, 1000, 'A');
  assert.equal(s.resume['yt:a'].t, 120);
  assert.equal(s.resume['yt:a'].title, 'Tea ceremony');

  const r = recordProgress(s, { key: 'yt:a', t: 590, dur: 600 }, 2000, 'A');
  assert.equal(r.finished, true);
  assert.equal(s.resume['yt:a'].del, true, 'resume point tombstoned once finished');
  assert.equal(s.watched['yt:a'].title, undefined);
});

test('progress: title from an earlier tick survives a tick without one', () => {
  const s = emptyState();
  recordProgress(s, { key: 'yt:a', t: 100, dur: 600, title: 'Kept', ch: 'Chan' }, 1000, 'A');
  recordProgress(s, { key: 'yt:a', t: 200, dur: 600 }, 2000, 'A');
  assert.equal(s.resume['yt:a'].title, 'Kept');
  assert.equal(s.resume['yt:a'].ch, 'Chan');
});

test('nextAt: a lagging clock still supersedes what it has seen', () => {
  assert.equal(nextAt({ at: 5000 }, 1000), 5001);
  assert.equal(nextAt({ at: 500 }, 1000), 1000);
  const s = emptyState();
  mergeInto(s, { resume: { 'yt:a': { at: 9000, dev: 'B', t: 100, dur: 600 } } });
  forget(s, 'resume', 'yt:a', 1000, 'A'); // device A's clock is behind
  assert.equal(s.resume['yt:a'].del, true);
  assert.ok(s.resume['yt:a'].at > 9000);
});

test('search: dedupes repeats within the window, keeps later repeats', () => {
  const s = emptyState();
  assert.ok(recordSearch(s, { q: ' rust  async ', src: 'google' }, 0, 'A', ids));
  assert.equal(recordSearch(s, { q: 'rust async', src: 'google' }, 60_000, 'A', ids), null);
  assert.ok(recordSearch(s, { q: 'rust async', src: 'duckduckgo' }, 60_000, 'A', ids));
  assert.ok(recordSearch(s, { q: 'rust async', src: 'google' }, 11 * 60_000, 'A', ids));
  assert.equal(listLive(s, 'searches').length, 3);
});

test('forget hides entries from lists', () => {
  const s = emptyState();
  recordProgress(s, { key: 'yt:a', t: 100, dur: 600, title: 'One' }, 1, 'A');
  recordProgress(s, { key: 'yt:b', t: 100, dur: 600, title: 'Two' }, 2, 'A');
  assert.equal(forget(s, 'resume', 'yt:a', 3, 'A'), true);
  assert.equal(forget(s, 'resume', 'yt:a', 4, 'A'), false, 'already forgotten');
  assert.deepEqual(listLive(s, 'resume').map((e) => e.key), ['yt:b']);
  assert.deepEqual(listLive(s, 'resume', { query: 'two' }).map((e) => e.key), ['yt:b']);
  assert.deepEqual(listLive(s, 'resume', { query: 'one' }), []);
});

test('sanitize rejects junk and caps sizes', () => {
  assert.equal(sanitizeRecord('resume', { at: -1, dev: 'A', t: 1, dur: 2 }), null);
  assert.equal(sanitizeRecord('resume', { at: 1, dev: 'A', t: 'x', dur: 2 }), null);
  assert.equal(sanitizeRecord('searches', { at: 1, dev: 'A', q: '', src: 'g' }), null);
  assert.equal(sanitizeRecord('searches', { at: 1, dev: 'A', q: 'x'.repeat(9999), src: 'g' }).q.length, 500);
  const s = emptyState();
  mergeInto(s, { resume: { __proto__: null, ['__proto__']: { at: 1, dev: 'A', t: 1, dur: 2 } }, bogus: { x: 1 } });
  assert.equal(Object.keys(s.resume).length, 0);
  assert.equal(s.bogus, undefined);
});

test('progressFor: re-watching shows partial progress, finished shows full', () => {
  const s = emptyState();
  recordProgress(s, { key: 'yt:a', t: 300, dur: 600 }, 1, 'A');
  recordProgress(s, { key: 'yt:b', t: 600, dur: 600, ended: true }, 1, 'A');
  const p = progressFor(s, ['yt:a', 'yt:b', 'yt:c']);
  assert.equal(p['yt:a'].p, 0.5);
  assert.deepEqual(p['yt:b'], { p: 1, w: true });
  assert.equal(p['yt:c'], undefined);
  recordProgress(s, { key: 'yt:b', t: 60, dur: 600 }, 5, 'A'); // watching again
  assert.equal(progressFor(s, ['yt:b'])['yt:b'].p, 0.1);
});

// ---------------------------------------------------------------------------
// CRDT laws, checked on random histories from three devices.
// ---------------------------------------------------------------------------

function rng(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function randomState(rand, dev) {
  const s = emptyState();
  for (let i = 0; i < 40; i++) {
    const key = `yt:${Math.floor(rand() * 8)}`;
    const at = Math.floor(rand() * 50); // lots of timestamp collisions on purpose
    const r = rand();
    if (r < 0.5) recordProgress(s, { key, t: 20 + rand() * 500, dur: 600, title: `T${i}` }, at, dev);
    else if (r < 0.65) recordProgress(s, { key, t: 600, dur: 600, ended: true }, at, dev);
    else if (r < 0.8) forget(s, rand() < 0.5 ? 'resume' : 'watched', key, at, dev);
    else recordSearch(s, { q: `q${Math.floor(rand() * 5)}`, src: 'google' }, at * 1e6, dev, () => `s${Math.floor(rand() * 6)}`);
  }
  return s;
}

test('merge is commutative, associative and idempotent', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = rng(seed);
    const a = randomState(rand, 'A');
    const b = randomState(rand, 'B');
    const c = randomState(rand, 'C');
    assert.equal(canon(merge(a, b)), canon(merge(b, a)), `commutative (seed ${seed})`);
    assert.equal(canon(merge(merge(a, b), c)), canon(merge(a, merge(b, c))), `associative (seed ${seed})`);
    assert.equal(canon(merge(a, a)), canon(merge(a, emptyState())), `idempotent (seed ${seed})`);
    const ab = merge(a, b);
    assert.equal(mergeInto(ab, a), 0, `re-merging a subset changes nothing (seed ${seed})`);
  }
});

test('a stale snapshot can never undo newer data', () => {
  const old = emptyState();
  recordProgress(old, { key: 'yt:a', t: 100, dur: 600 }, 1000, 'A');
  const newer = merge(old, emptyState());
  forget(newer, 'resume', 'yt:a', 2000, 'B');
  mergeInto(newer, old); // relay replays the old blob
  assert.equal(newer.resume['yt:a'].del, true);
});
