// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, editDistance, compileQuery, matchScore } from '../extension/src/core/search.js';
import { emptyState, recordProgress, recordSearch, listLive } from '../extension/src/core/model.js';

const score = (query, text) => matchScore(compileQuery(query), text);

test('normalize folds case, width, accents and kana', () => {
  assert.equal(normalize('Café CRÈME'), 'cafe creme');
  assert.equal(normalize('ｶﾀｶﾅ'), normalize('カタカナ'), 'half-width = full-width');
  assert.equal(normalize('カタカナ'), 'かたかな', 'katakana = hiragana');
  assert.equal(normalize('ＦＵＬＬ１２'), 'full12');
});

test('edit distance (with transpositions) and early exit', () => {
  assert.equal(editDistance('kintsugi', 'kintsugi'), 0);
  assert.equal(editDistance('kintusgi', 'kintsugi'), 1, 'swap counts as one');
  assert.equal(editDistance('kitsugi', 'kintsugi'), 1);
  assert.equal(editDistance('abc', 'xyz'), 3);
  assert.equal(editDistance('aaaaaaaa', 'bbbbbbbb', 2), 3, 'gives up past max');
});

test('words match in any order, with typos, partial words and abbreviations', () => {
  const t = 'Kintsugi: the Japanese art of golden repair';
  assert.equal(score('kintsugi', t), 1);
  assert.equal(score('golden kintsugi', t), 1, 'order-free');
  assert.equal(score('tsugi', t), 0.9, 'mid-word substring');
  assert.ok(score('kintusgi', t) > 0, 'transposition');
  assert.ok(score('kintsgi repiar', t) > 0, 'a typo in each word');
  assert.ok(score('japanes', t) > 0, 'still typing');
  assert.ok(score('kntsg', t) > 0, 'letters in order');
  assert.equal(score('kintsugi pottery', t), 0, 'every word must match');
  assert.equal(score('xyz', t), 0);
  assert.equal(score('arf', t), 0, 'short words need to be exact');
  assert.ok(score('kintsugi', t) > score('kintusgi', t), 'exact beats typo');
  assert.ok(score('kintusgi', t) > score('kntsg', t), 'typo beats abbreviation');
});

test('accents, width and scripts', () => {
  assert.ok(score('cafe', 'Café culture in Kyoto') > 0);
  assert.ok(score('東京', '東京タワーの夜景') > 0, 'CJK substring');
  assert.ok(score('とうきょう', 'トウキョウ ナイト') > 0, 'hiragana finds katakana');
  assert.ok(score('ﾄｳｷｮｳ', 'トウキョウ') > 0, 'half-width finds full-width');
});

test('listLive: fuzzy filter ranked by quality, then recency', () => {
  const s = emptyState();
  let n = 0;
  recordProgress(s, { key: 'yt:AAAAAAAAAAA', t: 100, dur: 600, title: 'Kintsugi documentary' }, 1000, 'A');
  recordProgress(s, { key: 'yt:BBBBBBBBBBB', t: 100, dur: 600, title: 'Kitsune folklore', ch: 'Kintsugi Studio' }, 3000, 'A');
  recordProgress(s, { key: 'yt:CCCCCCCCCCC', t: 100, dur: 600, title: 'Bread baking' }, 2000, 'A');
  assert.deepEqual(listLive(s, 'resume').map((e) => e.key), ['yt:BBBBBBBBBBB', 'yt:CCCCCCCCCCC', 'yt:AAAAAAAAAAA'], 'no query: newest first');
  assert.deepEqual(listLive(s, 'resume', { query: 'kintusgi' }).map((e) => e.key), ['yt:BBBBBBBBBBB', 'yt:AAAAAAAAAAA'], 'typo: equal quality, newest first');
  assert.deepEqual(listLive(s, 'resume', { query: 'documentary kintsugi' }).map((e) => e.key), ['yt:AAAAAAAAAAA']);
  assert.ok(!('_score' in listLive(s, 'resume', { query: 'kintsugi' })[0]), 'internal score not leaked');

  recordSearch(s, { q: 'kintsugi gold', src: 'google' }, 5000, 'A', () => `s${++n}`);
  assert.equal(listLive(s, 'searches', { query: 'gold kintsugi' }).length, 1);
});
