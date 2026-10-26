// Runs the bundled YouTube content script inside jsdom against a fake player,
// to check the tricky bits: SPA navigation, the reused <video> element, ads,
// resume gating, and the closed-shadow thumbnail markers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../extension/src/content/youtube.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bundle() {
  const out = await build({ entryPoints: [entry], bundle: true, format: 'iife', write: false, logLevel: 'silent' });
  return out.outputFiles[0].text;
}

function fakeVideo(video) {
  const s = { readyState: 0, currentSrc: '', duration: NaN, currentTime: 0, paused: true };
  for (const k of Object.keys(s)) {
    Object.defineProperty(video, k, { get: () => s[k], set: (v) => (s[k] = v), configurable: true });
  }
  return s;
}

test('youtube content script: resume, progress, SPA nav, ads, thumbnails, search', async () => {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>My Video - YouTube</title></head><body>
      <div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video></div>
      <ytd-watch-metadata><h1>My Video</h1><ytd-channel-name><a>Chan</a></ytd-channel-name></ytd-watch-metadata>
      <div id="related"><a id="thumb" href="/watch?v=CCCCCCCCCCC"><img></a><a href="/watch?v=CCCCCCCCCCC">title link</a></div>
    </body></html>`,
    { url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const { window } = dom;
  const sent = [];
  window.browser = {
    extension: { inIncognitoContext: false },
    runtime: {
      async sendMessage(msg) {
        msg = JSON.parse(JSON.stringify(msg)); // out of the jsdom realm, for deepEqual
        sent.push(msg);
        const result = {
          features: { recording: true, resume: true, badges: true, searches: true, unlocked: true },
          getResume: msg.key === 'yt:AAAAAAAAAAA' ? { t: 300, dur: 1200 } : null,
          getMany: { 'yt:CCCCCCCCCCC': { p: 0.5, w: false } },
        }[msg.type];
        return { ok: true, result: result ?? { ok: true } };
      },
    },
  };
  try {
    const video = window.document.querySelector('video');
    const v = fakeVideo(video);
    const fire = (name) => video.dispatchEvent(new window.Event(name));
    const progress = () => sent.filter((m) => m.type === 'progress');

    window.eval(await bundle());
    await sleep(50);
    assert.equal(sent[0].type, 'features');

    // Metadata loads → asks for a resume point → seeks there and shows a toast.
    Object.assign(v, { readyState: 1, currentSrc: 'blob:a', duration: 1200, currentTime: 0 });
    fire('loadedmetadata');
    await sleep(20);
    assert.ok(sent.some((m) => m.type === 'getResume' && m.key === 'yt:AAAAAAAAAAA'));
    assert.equal(v.currentTime, 300, 'resumed');
    const toast = window.document.querySelector('tsz-toast');
    assert.ok(toast, 'toast shown');
    assert.equal(toast.shadowRoot, null, 'toast internals are in a closed shadow root');

    // Playing → periodic progress, with title and channel.
    Object.assign(v, { currentTime: 310, paused: false });
    fire('timeupdate');
    assert.deepEqual(progress().at(-1), { type: 'progress', key: 'yt:AAAAAAAAAAA', t: 310, dur: 1200, title: 'My Video', ch: 'Chan', ended: false });
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
    assert.deepEqual(sent.at(-1), { type: 'search', q: 'fire emblem 8', src: 'youtube' });
  } finally {
    window.close(); // stops the script's intervals
  }
});

test('youtube content script does nothing in private windows', async () => {
  const dom = new JSDOM('<!doctype html><video></video>', {
    url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const sent = [];
  dom.window.browser = { extension: { inIncognitoContext: true }, runtime: { sendMessage: async (m) => (sent.push(m), { ok: true }) } };
  dom.window.eval(await bundle());
  await sleep(50);
  assert.deepEqual(sent, []);
  dom.window.close();
});
