// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives the real popup UI (in jsdom) against the real background logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBackground } from '../extension/src/background/core.js';
import { fakeBrowser, PAGE, CONTENT, contentCall } from './helpers/fake-browser.mjs';
import { SERVICES } from '../extension/src/core/services.js';

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

test('popup: create vault, browse lists safely, settings, lock/unlock', async () => {
  const js = (await build({ entryPoints: [fileURLToPath(new URL('app.js', uiDir))], bundle: true, format: 'iife', write: false, logLevel: 'silent' })).outputFiles[0].text;
  const html = readFileSync(new URL('popup.html', uiDir), 'utf8').replace('<script src="app.js"></script>', '');

  const bg = createBackground(fakeBrowser({}), { kdfIterations: 2000 });
  const dom = new JSDOM(html, { url: 'moz-extension://tsuzuki-test/ui/popup.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const opened = [];
  window.browser = {
    runtime: {
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: (msg) =>
        bg.handle(JSON.parse(JSON.stringify(msg)), PAGE).then(
          (result) => ({ ok: true, result: result ?? null }),
          (e) => ({ ok: false, error: e.message }),
        ),
    },
    tabs: { create: ({ url }) => opened.push(url) },
  };
  const realClose = window.close.bind(window);
  window.close = () => {}; // the popup closes itself after opening a link
  const $ = (sel) => doc.querySelector(sel);
  const $$ = (sel) => [...doc.querySelectorAll(sel)];
  const byText = (sel, text) => $$(sel).find((el) => el.textContent.trim() === text);
  const type = (el, value) => {
    el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  };

  try {
    window.eval(js);

    // Setup screen.
    await until(() => byText('button', 'Create vault'), 'setup form');
    const [pass, confirm] = $$('input[type=password]');
    type(pass, 'short');
    type(confirm, 'short');
    $('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => $('.notice.err'), 'validation error');
    assert.match($('.notice.err').textContent, /at least 12/);

    type($$('input[type=password]')[0], 'four random words here');
    type($$('input[type=password]')[1], 'four random words here');
    $('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => byText('h2', 'Vault ready'), 'vault created');
    const code = $('.code').textContent;
    assert.match(code, /^[A-Za-z0-9_-]{22}$/);
    byText('button', 'Start remembering').click();
    await until(() => $('.tab'), 'main view');

    // Record something with a hostile title, then look at the list.
    await bg.handle({ type: 'progress', service: 'youtube', key: 'yt:AAAAAAAAAAA', t: 125, dur: 600, title: '<img src=x onerror="window.pwned=1">', ch: 'Chan' }, CONTENT);
    byText('.tab', 'Settings').click();
    $$('.tab')[0].click(); // back to "Continue", which re-fetches the list
    const title = await until(() => $('.item .title'), 'list item');
    assert.equal(title.textContent, '<img src=x onerror="window.pwned=1">', 'rendered as text');
    assert.equal($('.item img'), null);
    assert.equal(window.pwned, undefined);
    assert.match($('.item .meta').textContent, /Chan · 2:05 of 10:00/);

    title.click();
    assert.deepEqual(opened, ['https://www.youtube.com/watch?v=AAAAAAAAAAA&t=125s']);

    // Filter.
    type($('.filter'), 'nothing like this');
    await until(() => $('.empty'), 'empty filter result');
    type($('.filter'), 'chan');
    await until(() => $('.item'), 'filtered item');

    // Forget.
    $('.item .x').click();
    await until(() => !$('.item'), 'item removed');

    // Searches: labelled by engine, and can be re-run on any other enabled engine.
    await contentCall(bg, 'search', { q: 'kintsugi', src: 'google' });
    type($('.filter'), ''); // the filter carries across tabs
    $$('.tab').find((t) => t.textContent.startsWith('Searches')).click();
    const again = await until(() => $('select.again'), 'search-again menu');
    assert.match($('.item .meta').textContent, /^Google · /);
    const labels = [...again.options].map((o) => o.textContent);
    assert.ok(labels.includes('DuckDuckGo') && labels.includes('YouTube'));
    assert.ok(!labels.includes('Google'), 'not the engine it came from');
    assert.ok(!labels.includes('Naver'), 'not engines that are switched off');
    again.value = 'duckduckgo';
    again.dispatchEvent(new window.Event('change'));
    assert.equal(opened.at(-1), 'https://duckduckgo.com/?q=kintsugi');

    // Settings renders the vault code, toggles and one chip per service.
    byText('.tab', 'Settings').click();
    await until(() => $$('.code').some((c) => c.textContent === code), 'vault code in settings');
    assert.equal($$('.toggle input[type=checkbox]').length, 5);
    assert.equal($$('.chip input').length, SERVICES.length);
    const nebula = $$('.chip').find((c) => c.textContent === 'Nebula').querySelector('input');
    assert.equal(nebula.checked, false, 'new services start off');
    nebula.click();
    await until(() => $('.notice.ok')?.textContent.startsWith('Nebula on'), 'service saved');
    assert.equal((await bg.handle({ type: 'status' }, PAGE)).cfg.services.nebula, true);
    assert.match(byText('h2', 'Your instances').parentElement.textContent, /Firefox \/ Zen/);

    // Lock → locked screen → unlock.
    byText('button', 'Lock').click();
    await until(() => byText('button', 'Unlock'), 'locked view');
    type($('input[type=password]'), 'four random words here');
    $('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => byText('.tab', 'Settings'), 'unlocked again');
  } finally {
    realClose();
  }
});

test('appearance: picking a theme and custom CSS restyles the page; unsafe CSS is refused', async () => {
  const js = (await build({ entryPoints: [fileURLToPath(new URL('app.js', uiDir))], bundle: true, format: 'iife', write: false, logLevel: 'silent' })).outputFiles[0].text;
  const html = readFileSync(new URL('options.html', uiDir), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
  const bg = createBackground(fakeBrowser({}), { kdfIterations: 2000 });
  await bg.handle({ type: 'create', passphrase: 'appearance test pass' }, PAGE);
  // An http origin here because jsdom gives moz-extension:// pages no localStorage (the app copes; the test wants to look).
  const dom = new JSDOM(html, { url: 'http://tsuzuki.test/ui/options.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  window.browser = {
    runtime: {
      getManifest: () => ({ version: '0' }),
      getURL: (p) => `moz-extension://tsuzuki-test/${p}`,
      sendMessage: (msg) => bg.handle(JSON.parse(JSON.stringify(msg)), PAGE).then((result) => ({ ok: true, result: result ?? null }), (e) => ({ ok: false, error: e.message })),
    },
    tabs: { create() {} },
  };
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => [...doc.querySelectorAll(s)];
  try {
    window.eval(js);
    const until = async (fn, what) => {
      for (let i = 0; i < 200; i++) {
        const v = fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    await until(() => $$('.tab').length, 'main view');
    $$('.tab').find((t) => t.textContent === 'Settings').click();
    await until(() => $$('.theme-pick').length === 5, 'theme picker');
    assert.equal(doc.documentElement.getAttribute('data-theme'), null, 'auto = no attribute');

    $$('.theme-pick').find((b) => b.textContent === 'Aero').click();
    await until(() => doc.documentElement.getAttribute('data-theme') === 'aero', 'aero applied');
    assert.equal(JSON.parse(window.localStorage.getItem('tsz:appearance')).theme, 'aero', 'cached for the next page load');

    const css = $('textarea.css-edit');
    css.value = ':root { --shu: hotpink; }';
    $$('button').find((b) => b.textContent === 'Apply CSS').click();
    await until(() => $('#tsz-custom-css')?.textContent === ':root { --shu: hotpink; }', 'custom css applied');
    assert.equal(doc.head.lastElementChild.id, 'tsz-custom-css', 'loads after the theme stylesheets');

    $('textarea.css-edit').value = 'a { background: url(https://evil.example/seen) }';
    $$('button').find((b) => b.textContent === 'Apply CSS').click();
    await until(() => $('.notice.err'), 'refusal');
    assert.match($('.notice.err').textContent, /network/);
    assert.equal($('#tsz-custom-css').textContent, ':root { --shu: hotpink; }', 'old CSS kept');

    $$('button').find((b) => b.textContent === 'Clear').click();
    await until(() => !$('#tsz-custom-css'), 'custom css removed');
  } finally {
    window.close();
  }
});
