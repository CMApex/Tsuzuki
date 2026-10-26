// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  youtubeVideo, youtubeStartTime, youtubeLink, formatTime, parseTimeSpec,
} from '../extension/src/core/parse.js';

test('youtubeVideo recognises the URL shapes YouTube uses', () => {
  const id = 'dQw4w9WgXcQ';
  for (const [url, kind] of [
    [`https://www.youtube.com/watch?v=${id}`, 'watch'],
    [`https://m.youtube.com/watch?v=${id}&feature=share`, 'watch'],
    [`https://music.youtube.com/watch?v=${id}&list=RD`, 'watch'],
    [`https://youtu.be/${id}?t=42`, 'watch'],
    [`https://www.youtube.com/shorts/${id}`, 'shorts'],
    [`https://www.youtube.com/live/${id}`, 'live'],
    [`https://www.youtube-nocookie.com/embed/${id}`, 'embed'],
  ]) {
    assert.deepEqual(youtubeVideo(url), { id, key: `yt:${id}`, kind }, url);
  }
  for (const url of [
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=short',
    'https://evil-youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com.evil.net/watch?v=dQw4w9WgXcQ',
    'not a url',
  ]) {
    assert.equal(youtubeVideo(url), null, url);
  }
});

test('youtubeStartTime parses every t= format', () => {
  const base = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  assert.equal(youtubeStartTime(`${base}&t=90`), 90);
  assert.equal(youtubeStartTime(`${base}&t=90s`), 90);
  assert.equal(youtubeStartTime(`${base}&t=1h2m3s`), 3723);
  assert.equal(youtubeStartTime(`${base}&t=4m`), 240);
  assert.equal(youtubeStartTime(`${base}#t=30`), 30);
  assert.equal(youtubeStartTime(base), null);
  assert.equal(youtubeStartTime(`${base}&t=banana`), null);
});

test('youtubeLink round-trips', () => {
  const link = youtubeLink('yt:dQw4w9WgXcQ', 754.6);
  assert.equal(link, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754s');
  assert.equal(youtubeStartTime(link), 754);
});

test('formatTime and parseTimeSpec', () => {
  assert.equal(formatTime(5), '0:05');
  assert.equal(formatTime(754), '12:34');
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(parseTimeSpec('1h2m3s'), 3723);
  assert.equal(parseTimeSpec('45'), 45);
  assert.equal(parseTimeSpec(''), null);
});
