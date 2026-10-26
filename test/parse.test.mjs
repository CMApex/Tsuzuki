import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  youtubeVideo, youtubeStartTime, youtubeLink, searchFromUrl, searchLink, formatTime,
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

test('searchFromUrl covers the supported engines', () => {
  assert.deepEqual(searchFromUrl('https://www.google.com/search?q=hermetic+corpus&hl=en'), { q: 'hermetic corpus', src: 'google' });
  assert.deepEqual(searchFromUrl('https://www.google.co.jp/search?q=%E7%B6%9A%E3%81%8D'), { q: '続き', src: 'google' });
  assert.deepEqual(searchFromUrl('https://www.youtube.com/results?search_query=fe8+speedrun'), { q: 'fe8 speedrun', src: 'youtube' });
  assert.deepEqual(searchFromUrl('https://duckduckgo.com/?q=meshtastic&ia=web'), { q: 'meshtastic', src: 'duckduckgo' });
  assert.deepEqual(searchFromUrl('https://html.duckduckgo.com/html/?q=x'), { q: 'x', src: 'duckduckgo' });
  assert.deepEqual(searchFromUrl('https://www.bing.com/search?q=y'), { q: 'y', src: 'bing' });
  assert.deepEqual(searchFromUrl('https://search.brave.com/search?q=z'), { q: 'z', src: 'brave' });
  assert.equal(searchFromUrl('https://www.google.com/maps?q=tokyo'), null);
  assert.equal(searchFromUrl('https://www.google.com/search?q=+++'), null);
  assert.equal(searchFromUrl('https://google.evil.com/search?q=x'), null);
});

test('searchLink and formatTime', () => {
  assert.equal(searchLink('a b&c', 'duckduckgo'), 'https://duckduckgo.com/?q=a%20b%26c');
  assert.equal(searchLink('x', 'unknown-engine'), 'https://www.google.com/search?q=x');
  assert.equal(formatTime(5), '0:05');
  assert.equal(formatTime(754), '12:34');
  assert.equal(formatTime(3723), '1:02:03');
});
