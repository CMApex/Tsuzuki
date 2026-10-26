// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives the real home page (in jsdom) against the real background logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBackground } from '../extension/src/background/core.js';
import { fakeBrowser, PAGE, contentCall, addInstanceApis } from './helpers/fake-browser.mjs';

const uiDir = new URL('../extension/src/ui/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function openHome(bg) {
  const js = (await build({ entryPoints: [fileURLToPath(new URL('home.js', uiDir))], bundle: true, format: 'iife', write: false, logLevel: 'silent' })).outputFiles[0].text;
  const html = readFileSync(new URL('home.html', uiDir), 'utf8').replace('<script src="home.js"></script>', '');
  const dom = new JSDOM(html, { url: 'moz-extension://tsuzuki-test/ui/home.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const went = [];
  window.__tsuzukiNavigate = (u) => went.push(u);
  window.browser = {
    runtime: {
      getURL: (p) => `moz-extension://tsuzuki-test/${p}`,
      getManifest: () => ({ version: '0.2.0' }),
      sendMessage: (msg) =>
        bg.handle(JSON.parse(JSON.stringify(msg)), PAGE).then(
          (result) => ({ ok: true, result: result ?? null }),
          (e) => ({ ok: false, error: e.message }),
        ),
    },
  };
  window.eval(js);
  const doc = window.document;
  return {
    window,
    doc,
    went,
    $: (s) => doc.querySelector(s),
    $$: (s) => [...doc.querySelectorAll(s)],
    type(el, v) {
      el.value = v;
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    key(el, key) {
      el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
    },
    close: () => window.close(),
  };
}

const PASS = 'home page passphrase';

test('home: gates, continue watching across services, search box, bangs, history matches', async () => {
  const bg = createBackground(fakeBrowser({}), { kdfIterations: 2000 });
  let p = await openHome(bg);
  await until(() => p.doc.body.textContent.includes('Set up Tsuzuki'), 'setup gate');
  p.close();

  await bg.handle({ type: 'create', passphrase: PASS }, PAGE);
  await bg.handle({ type: 'settings', services: { nebula: true } }, PAGE);
  await contentCall(bg, 'progress', { key: 'yt:AAAAAAAAAAA', t: 125, dur: 600, title: 'Kintsugi documentary <b>', ch: 'Craft' });
  await contentCall(bg, 'progress', { service: 'nebula', key: 'nebula:trains', t: 300, dur: 1200, title: 'Why trains' }, 'https://nebula.tv/videos/trains');
  await contentCall(bg, 'progress', { key: 'yt:BBBBBBBBBBB', t: 600, dur: 600, ended: true, title: 'Finished thing' });
  await contentCall(bg, 'search', { q: 'kintsugi gold', src: 'google' });

  p = await openHome(bg);
  const { $, $$, went } = p;
  try {
    await until(() => $$('.card-v').length === 2, 'two continue cards');
    const titles = $$('.card-v .ttl').map((t) => t.textContent);
    assert.ok(titles.includes('Kintsugi documentary <b>'), 'text, not HTML');
    assert.equal($('.card-v b'), null);
    assert.ok($$('.card-v').some((c) => c.getAttribute('href') === 'https://nebula.tv/videos/trains'));
    assert.ok($$('.thumb .left').some((x) => x.textContent === '7:55 left'));
    assert.equal($('.thumb img'), null, 'no thumbnails by default (they would leak to YouTube)');
    assert.match($('.done').textContent, /Finished thing/);
    assert.match($('.searches').textContent, /kintsugi gold/);

    // Service filter.
    $$('.filters .engine').find((b) => b.textContent === 'Nebula').click();
    await until(() => $$('.card-v').length === 1, 'filtered to nebula');
    $$('.filters .engine').find((b) => b.textContent === 'All').click();
    await until(() => $$('.card-v').length === 2, 'all again');

    // Enter searches the default engine; a bang overrides it.
    const q = $('.qbox input');
    p.type(q, 'local first software');
    p.key(q, 'Enter');
    assert.equal(went.at(-1), 'https://duckduckgo.com/?q=local%20first%20software');
    p.type(q, 'fire emblem !yt');
    p.key(q, 'Enter');
    assert.equal(went.at(-1), 'https://www.youtube.com/results?search_query=fire%20emblem');

    // Clicking an engine with an empty box makes it the default.
    p.type(q, '');
    $$('.engine').find((b) => b.textContent === 'Kagi').click();
    await until(() => $$('.engines .engine[aria-pressed="true"]')[0]?.textContent === 'Kagi', 'kagi default');
    p.type(q, 'tea');
    p.key(q, 'Enter');
    assert.equal(went.at(-1), 'https://kagi.com/search?q=tea');

    // Typing shows matches from your own history; arrows + Enter open one.
    p.type(q, 'kintsugi');
    await until(() => $$('.matches a').length === 2, 'history matches');
    assert.deepEqual($$('.matches .kind').map((k) => k.textContent), ['Continue', 'Searched']);
    p.key(q, 'ArrowDown');
    p.key(q, 'Enter');
    assert.equal(went.at(-1), 'https://www.youtube.com/watch?v=AAAAAAAAAAA&t=125s');

    // Search again on another engine.
    const again = $('.searches select.again');
    again.value = 'bing';
    again.dispatchEvent(new p.window.Event('change'));
    assert.equal(went.at(-1), 'https://www.bing.com/search?q=kintsugi%20gold');

    // Forget from the grid.
    $$('.card-v').find((c) => c.textContent.includes('Why trains')).querySelector('.x').click();
    await until(() => $$('.card-v').length === 1, 'card forgotten');

    // Lock → gate → unlock.
    $$('button').find((b) => b.textContent === 'Lock').click();
    await until(() => p.doc.body.textContent.includes('Locked'), 'locked gate');
    const pass = $('input[type=password]');
    pass.value = PASS;
    $('form').dispatchEvent(new p.window.Event('submit', { cancelable: true }));
    await until(() => $$('.card-v').length === 1, 'unlocked again');
  } finally {
    p.close();
  }
});

test('home: thumbnails are opt-in and go through your Invidious when you have one', async () => {
  const api = fakeBrowser({});
  addInstanceApis(api, new Set(['https://yewtu.be/*']));
  const bg = createBackground(api, { kdfIterations: 2000 });
  await bg.handle({ type: 'create', passphrase: PASS }, PAGE);
  await contentCall(bg, 'progress', { key: 'yt:AAAAAAAAAAA', t: 125, dur: 600 });

  let p = await openHome(bg);
  await until(() => p.$('.card-v'), 'card');
  const box = p.$('.home-foot input[type=checkbox]');
  assert.match(box.parentElement.textContent, /loads from YouTube/);
  box.click();
  await until(() => p.$('.thumb img'), 'thumbnail on');
  assert.equal(p.$('.thumb img').getAttribute('src'), 'https://i.ytimg.com/vi/AAAAAAAAAAA/mqdefault.jpg');
  assert.equal(p.$('.thumb img').getAttribute('referrerpolicy'), 'no-referrer');
  p.close();

  await bg.handle({ type: 'addInstance', url: 'yewtu.be', instanceType: 'invidious' }, PAGE);
  p = await openHome(bg);
  await until(() => p.$('.thumb img'), 'thumbnail');
  assert.equal(p.$('.thumb img').getAttribute('src'), 'https://yewtu.be/vi/AAAAAAAAAAA/mqdefault.jpg');
  // Instances show up as engines and bangs.
  assert.ok(p.$$('.engine').some((b) => b.textContent === 'Invidious · yewtu.be'));
  const q = p.$('.qbox input');
  p.type(q, '!inv some video');
  p.key(q, 'Enter');
  assert.equal(p.went.at(-1), 'https://yewtu.be/search?q=some%20video');
  p.close();
});

test('home: built-in vim-style keys (Vimium cannot run on extension pages)', async () => {
  let clock = Date.now() - 60_000;
  const bg = createBackground(fakeBrowser({}), { kdfIterations: 2000, now: () => (clock += 1000) });
  await bg.handle({ type: 'create', passphrase: PASS }, PAGE);
  await contentCall(bg, 'progress', { key: 'yt:AAAAAAAAAAA', t: 125, dur: 600, title: 'First video' });
  await contentCall(bg, 'progress', { key: 'yt:BBBBBBBBBBB', t: 200, dur: 600, title: 'Second video' });
  await contentCall(bg, 'search', { q: 'kintsugi', src: 'google' });

  const p = await openHome(bg);
  const { $, $$, doc, went, window } = p;
  const press = (key, opts = {}) => (doc.activeElement || doc.body).dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
  try {
    await until(() => $$('.card-v').length === 2, 'cards');
    const q = $('.qbox input');
    assert.equal(doc.activeElement, q, 'search box focused on load');

    // Typing letters in the box doesn't trigger shortcuts.
    press('j');
    assert.equal(doc.activeElement, q);

    // Esc and Ctrl+[ leave the box.
    press('Escape');
    assert.notEqual(doc.activeElement, q);
    press('/');
    assert.equal(doc.activeElement, q, '/ focuses search');
    press('[', { ctrlKey: true });
    assert.notEqual(doc.activeElement, q, 'Ctrl+[ works like Esc');

    // j/k move through items; o opens; G and gg jump.
    press('j');
    assert.equal(doc.activeElement.dataset.key, 'yt:BBBBBBBBBBB', 'newest first');
    press('j');
    assert.equal(doc.activeElement.dataset.key, 'yt:AAAAAAAAAAA');
    press('k');
    assert.equal(doc.activeElement.dataset.key, 'yt:BBBBBBBBBBB');
    press('G');
    assert.equal(doc.activeElement.dataset.nav, 'searches');
    press('g');
    press('g');
    assert.equal(doc.activeElement.dataset.key, 'yt:BBBBBBBBBBB');
    press('o');
    assert.equal(went.at(-1), 'https://www.youtube.com/watch?v=BBBBBBBBBBB&t=200s');

    // x forgets the selected item and keeps a selection.
    press('x');
    await until(() => $$('.card-v').length === 1, 'forgotten');
    assert.equal(doc.activeElement.dataset.key, 'yt:AAAAAAAAAAA', 'selection moves to the next item');

    // f shows link hints; typing a label activates it.
    press('f');
    const tags = $$('.hint-layer .link-hint');
    assert.ok(tags.length > 3, 'hints on links and buttons');
    // Regression: the help line under the search box is also class "hint"; it must not get link-hint styling.
    assert.ok(!$('p.hint').classList.contains('link-hint'));
    const cardHint = tags.find((t, i) => {
      const card = $('.card-v');
      return t.textContent && i === [...doc.querySelectorAll('a[href], button, select, input')].indexOf(card);
    });
    for (const ch of cardHint.textContent.toLowerCase()) press(ch);
    assert.equal($('.hint-layer'), null, 'hints closed');
    assert.equal(went.at(-1), 'https://www.youtube.com/watch?v=AAAAAAAAAAA&t=125s');
    press('f');
    press('Escape');
    assert.equal($('.hint-layer'), null, 'Esc cancels hints');

    // ? toggles help.
    press('?');
    assert.ok($('.help-layer'));
    press('Escape');
    assert.equal($('.help-layer'), null);
  } finally {
    p.close();
  }
});
