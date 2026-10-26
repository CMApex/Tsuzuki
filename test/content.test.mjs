// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the bundled content scripts inside jsdom against fake pages and players,
// to check the tricky bits: SPA navigation, the reused <video> element, ads,
// resume gating, closed-shadow thumbnail markers, per-service toggles, POSTed
// searches and user-added instances.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVICES } from '../extension/src/core/services.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bundles = new Map();

async function bundle(name) {
  if (!bundles.has(name)) {
    const entry = fileURLToPath(new URL(`../extension/src/content/${name}.js`, import.meta.url));
    const out = await build({ entryPoints: [entry], bundle: true, format: 'iife', write: false, logLevel: 'silent' });
    bundles.set(name, out.outputFiles[0].text);
  }
  return bundles.get(name);
}

function fakeVideo(video) {
  const s = { readyState: 0, currentSrc: '', duration: NaN, currentTime: 0, paused: true };
  for (const k of Object.keys(s)) {
    Object.defineProperty(video, k, { get: () => s[k], set: (v) => (s[k] = v), configurable: true });
  }
  return s;
}

/**
 * Load `script` into a jsdom page at `url`. `answer(msg)` supplies background replies;
 * features default to everything on with the default service toggles.
 */
async function load(script, url, body, { services = {}, answer = () => undefined, privateWindow = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head>${body.head || ''}</head><body>${body.body || ''}</body></html>`, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const sent = [];
  window.browser = {
    extension: { inIncognitoContext: privateWindow },
    runtime: {
      async sendMessage(msg) {
        msg = JSON.parse(JSON.stringify(msg)); // out of the jsdom realm, for deepEqual
        sent.push(msg);
        const custom = answer(msg);
        if (custom !== undefined) return { ok: true, result: custom };
        if (msg.type === 'features') {
          return { ok: true, result: { recording: true, resume: true, badges: true, searches: true, unlocked: true, services: { ...DEFAULT_SERVICES, ...services } } };
        }
        return { ok: true, result: null };
      },
    },
  };
  window.eval(await bundle(script));
  await sleep(40);
  const video = window.document.querySelector('video');
  return {
    window,
    sent,
    v: video && fakeVideo(video),
    fire: (name) => video.dispatchEvent(new window.Event(name)),
    progress: () => sent.filter((m) => m.type === 'progress'),
    close: () => window.close(), // stops the scripts' intervals
  };
}

test('YouTube: resume, progress, SPA nav, ads, thumbnails, search', async () => {
  const p = await load('video', 'https://www.youtube.com/watch?v=AAAAAAAAAAA', {
    head: '<title>My Video - YouTube</title>',
    body: `<div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video></div>
      <ytd-watch-metadata><h1>My Video</h1><ytd-channel-name><a>Chan</a></ytd-channel-name></ytd-watch-metadata>
      <div id="related"><a id="thumb" href="/watch?v=CCCCCCCCCCC"><img></a><a href="/watch?v=CCCCCCCCCCC">title link</a></div>`,
  }, {
    answer: (m) =>
      m.type === 'getResume' ? (m.key === 'yt:AAAAAAAAAAA' ? { t: 300, dur: 1200 } : null)
      : m.type === 'getMany' ? { 'yt:CCCCCCCCCCC': { p: 0.5, w: false } }
      : undefined,
  });
  const { window, sent, v, fire, progress } = p;
  try {
    assert.equal(sent[0].type, 'features');

    // Metadata loads → asks for a resume point → seeks there and shows a toast.
    Object.assign(v, { readyState: 1, currentSrc: 'blob:a', duration: 1200, currentTime: 0 });
    fire('loadedmetadata');
    await sleep(20);
    assert.ok(sent.some((m) => m.type === 'getResume' && m.key === 'yt:AAAAAAAAAAA' && m.service === 'youtube'));
    assert.equal(v.currentTime, 300, 'resumed');
    const toast = window.document.querySelector('tsz-toast');
    assert.ok(toast, 'toast shown');
    assert.equal(toast.shadowRoot, null, 'toast internals are in a closed shadow root');

    // Playing → periodic progress, with title and channel.
    Object.assign(v, { currentTime: 310, paused: false });
    fire('timeupdate');
    assert.deepEqual(progress().at(-1), { service: 'youtube', type: 'progress', key: 'yt:AAAAAAAAAAA', t: 310, dur: 1200, title: 'My Video', ch: 'Chan', ended: false });
    Object.assign(v, { currentTime: 312 });
    fire('timeupdate');
    assert.equal(progress().length, 1, 'throttled');
    Object.assign(v, { currentTime: 320, paused: true });
    fire('pause');
    assert.equal(progress().at(-1).t, 320, 'pause sends immediately');

    // Thumbnails get a marker (closed shadow root) on image links only.
    await sleep(900);
    assert.ok(sent.some((m) => m.type === 'getMany' && m.keys.includes('yt:CCCCCCCCCCC')));
    const marks = window.document.querySelectorAll('tsz-mark');
    assert.equal(marks.length, 1);
    assert.equal(marks[0].parentElement.id, 'thumb');
    assert.equal(marks[0].shadowRoot, null);

    // SPA navigation: the same <video> still holds the old media for a moment.
    window.history.pushState({}, '', '/watch?v=BBBBBBBBBBB');
    window.document.dispatchEvent(new window.Event('yt-navigate-finish'));
    const before = progress().length;
    Object.assign(v, { currentTime: 330, paused: false });
    fire('timeupdate');
    assert.equal(progress().length, before, 'old media not attributed to the new video');

    // New media arrives; no resume point for it; progress flows for the new key.
    Object.assign(v, { currentSrc: 'blob:b', duration: 600, currentTime: 0 });
    fire('loadedmetadata');
    await sleep(20);
    Object.assign(v, { currentTime: 40 });
    fire('timeupdate');
    assert.deepEqual([progress().at(-1).key, progress().at(-1).t], ['yt:BBBBBBBBBBB', 40]);

    // Mid-roll ad in the same element: ignored.
    window.document.getElementById('movie_player').classList.add('ad-showing');
    Object.assign(v, { currentSrc: 'blob:ad', duration: 15, currentTime: 5 });
    fire('pause');
    fire('ended');
    assert.equal(progress().at(-1).t, 40);
    window.document.getElementById('movie_player').classList.remove('ad-showing');

    // YouTube search pages are captured.
    window.history.pushState({}, '', '/results?search_query=fire+emblem+8');
    window.document.dispatchEvent(new window.Event('yt-navigate-finish'));
    await sleep(10);
    assert.deepEqual(sent.find((m) => m.type === 'search'), { type: 'search', q: 'fire emblem 8', src: 'youtube' });
  } finally {
    p.close();
  }
});

test('a switched-off service does nothing at all', async () => {
  const p = await load('video', 'https://www.youtube.com/watch?v=AAAAAAAAAAA', { body: '<video></video>' }, { services: { youtube: false, 'youtube-search': false } });
  try {
    Object.assign(p.v, { readyState: 1, currentSrc: 'blob:a', duration: 600, currentTime: 100, paused: true });
    p.fire('loadedmetadata');
    p.fire('pause');
    await sleep(20);
    assert.deepEqual(p.sent.map((m) => m.type), ['features']);
  } finally {
    p.close();
  }
});

test('Nebula: generic player, og:title, thumbnails', async () => {
  const p = await load('video', 'https://nebula.tv/videos/realengineering-trains', {
    head: '<meta property="og:title" content="Why Trains Are Hard"><title>Why Trains Are Hard – Nebula</title>',
    body: '<video></video><a href="/videos/other-video"><img></a>',
  }, { services: { nebula: true } });
  try {
    Object.assign(p.v, { readyState: 1, currentSrc: 'blob:n', duration: 1800, currentTime: 0 });
    p.fire('loadedmetadata');
    await sleep(20);
    Object.assign(p.v, { currentTime: 400, paused: true });
    p.fire('pause');
    assert.deepEqual(p.progress().at(-1), { service: 'nebula', type: 'progress', key: 'nebula:realengineering-trains', t: 400, dur: 1800, title: 'Why Trains Are Hard', ch: '', ended: false });
    await sleep(900);
    assert.ok(p.sent.some((m) => m.type === 'getMany' && m.service === 'nebula' && m.keys[0] === 'nebula:other-video'));
  } finally {
    p.close();
  }
});

test('Twitch VODs: ads are skipped', async () => {
  const p = await load('video', 'https://www.twitch.tv/videos/2283745519', {
    // Real Twitch VOD page shape: og:title stuck at "Twitch", the title only in document.title.
    head: '<meta property="og:title" content="Twitch"><title>WE WERE HERE TOMORROW WITH @rainhoe | !merch - Twitch</title>',
    body: '<div class="player"><span data-a-target="video-ad-label">Ad</span><video></video></div><h1>CDawg</h1>',
  }, { services: { twitch: true } });
  try {
    Object.assign(p.v, { readyState: 1, currentSrc: 'blob:ad', duration: 30, currentTime: 10, paused: true });
    p.fire('loadedmetadata');
    p.fire('pause');
    await sleep(20);
    assert.equal(p.progress().length, 0, 'ad ignored');

    p.window.document.querySelector('[data-a-target="video-ad-label"]').remove();
    Object.assign(p.v, { currentSrc: 'blob:vod', duration: 7200, currentTime: 0 });
    p.fire('loadedmetadata');
    await sleep(20);
    Object.assign(p.v, { currentTime: 3600 });
    p.fire('pause');
    const last = p.progress().at(-1);
    assert.deepEqual([last.key, last.t, last.title, last.ch], ['twitch:2283745519', 3600, 'WE WERE HERE TOMORROW WITH @rainhoe | !merch', 'CDawg']);
  } finally {
    p.close();
  }
});

test('Vimeo player iframes are tracked', async () => {
  const p = await load('video', 'https://player.vimeo.com/video/76979871', { head: '<title>The New Vimeo Player on Vimeo</title>', body: '<video></video>' }, { services: { vimeo: true } });
  try {
    Object.assign(p.v, { readyState: 1, currentSrc: 'blob:v', duration: 120, currentTime: 0 });
    p.fire('loadedmetadata');
    await sleep(20);
    Object.assign(p.v, { currentTime: 50 });
    p.fire('pause');
    assert.deepEqual([p.progress().at(-1).key, p.progress().at(-1).title], ['vimeo:76979871', 'The New Vimeo Player']);
  } finally {
    p.close();
  }
});

test('search engines: URL queries, POSTed queries, and switched-off engines', async () => {
  let p = await load('search', 'https://www.ecosia.org/search?q=trees', { body: '' }, { services: { ecosia: true } });
  assert.deepEqual(p.sent.at(-1), { type: 'search', q: 'trees', src: 'ecosia' });
  p.close();

  p = await load('search', 'https://html.duckduckgo.com/html/', { body: '<form><input name="q" value="meshtastic range"></form>' });
  assert.deepEqual(p.sent.at(-1), { type: 'search', q: 'meshtastic range', src: 'duckduckgo' });
  p.close();

  p = await load('search', 'https://www.startpage.com/sp/search', { body: '<input name="query" value="tea ceremony">' }, { services: { startpage: true } });
  assert.deepEqual(p.sent.at(-1), { type: 'search', q: 'tea ceremony', src: 'startpage' });
  p.close();

  p = await load('search', 'https://www.startpage.com/sp/search?query=x', { body: '' }); // Startpage is opt-in
  assert.deepEqual(p.sent.map((m) => m.type), ['features']);
  p.close();
});

test('instances: Invidious shares YouTube keys; SearXNG captures searches', async () => {
  let p = await load('instance', 'https://yewtu.be/watch?v=dQw4w9WgXcQ', { head: '<title>Never Gonna - Invidious</title>', body: '<video></video>' }, {
    answer: (m) => (m.type === 'instance' ? { type: 'invidious', enabled: true, features: { recording: true, resume: true, badges: true, searches: true } } : undefined),
  });
  try {
    Object.assign(p.v, { readyState: 1, currentSrc: 'blob:i', duration: 213, currentTime: 0 });
    p.fire('loadedmetadata');
    await sleep(20);
    Object.assign(p.v, { currentTime: 90 });
    p.fire('pause');
    assert.deepEqual([p.progress().at(-1).service, p.progress().at(-1).key, p.progress().at(-1).title], ['instance', 'yt:dQw4w9WgXcQ', 'Never Gonna']);
  } finally {
    p.close();
  }

  p = await load('instance', 'https://searx.example.org/search', { body: '<input name="q" value="local-first software">' }, {
    answer: (m) => (m.type === 'instance' ? { type: 'searxng', enabled: true, features: { recording: true, resume: true, badges: true, searches: true } } : undefined),
  });
  assert.deepEqual(p.sent.at(-1), { type: 'search', q: 'local-first software', src: 'searxng:searx.example.org' });
  p.close();

  p = await load('instance', 'https://yewtu.be/watch?v=dQw4w9WgXcQ', { body: '<video></video>' }, {
    answer: (m) => (m.type === 'instance' ? { type: 'invidious', enabled: false, features: { recording: true } } : undefined),
  });
  assert.deepEqual(p.sent.map((m) => m.type), ['instance'], 'disabled instance stays quiet');
  p.close();
});

test('nothing runs in private windows', async () => {
  for (const [script, url] of [['video', 'https://www.youtube.com/watch?v=AAAAAAAAAAA'], ['search', 'https://duckduckgo.com/?q=x'], ['instance', 'https://yewtu.be/']]) {
    const p = await load(script, url, { body: '<video></video>' }, { privateWindow: true });
    assert.deepEqual(p.sent, [], script);
    p.close();
  }
});
