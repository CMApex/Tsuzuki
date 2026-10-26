// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICES, INSTANCE_TYPES, DEFAULT_SERVICES, resolveServices, servicesForUrl, videoServiceForUrl, identifyVideo,
  searchFromUrl, instanceSearchFromUrl, normalizeInstanceUrl, linkForKey, labelForKey, labelForSrc, searchLinkFor,
  searchTargets, manifestContentScripts,
} from '../extension/src/core/services.js';

test('registry is well-formed', () => {
  const ids = new Set();
  for (const s of SERVICES) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.label && typeof s.default === 'boolean' && s.host instanceof RegExp, s.id);
    if (s.kind === 'video') assert.equal(typeof s.identify, 'function', s.id);
    if (s.kind === 'search') assert.ok(s.src && s.path && s.param && s.url.endsWith('='), s.id);
  }
  // The services that existed before per-service toggles stay on; the new ones are opt-in.
  const onByDefault = Object.entries(DEFAULT_SERVICES).filter(([, v]) => v).map(([k]) => k).sort();
  assert.deepEqual(onByDefault, ['bing', 'brave', 'duckduckgo', 'google', 'kagi', 'youtube', 'youtube-music', 'youtube-search']);
  assert.equal(resolveServices({ nebula: true, youtube: false, junk: true }).nebula, true);
  assert.equal(resolveServices({ youtube: false }).youtube, false);
  assert.equal(resolveServices({}).junk, undefined);
});

test('video URLs → keys, for every video service', () => {
  const cases = [
    ['youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
    ['youtube', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30', 'yt:dQw4w9WgXcQ'],
    ['youtube', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', null],
    ['youtube-music', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD', 'yt:dQw4w9WgXcQ'],
    ['nebula', 'https://nebula.tv/videos/realengineering-why-trains-are-hard', 'nebula:realengineering-why-trains-are-hard'],
    ['nebula', 'https://nebula.tv/realengineering', null],
    ['twitch', 'https://www.twitch.tv/videos/2283745519?t=1h2m3s', 'twitch:2283745519'],
    ['twitch', 'https://www.twitch.tv/somestreamer', null],
    ['vimeo', 'https://vimeo.com/76979871', 'vimeo:76979871'],
    ['vimeo', 'https://vimeo.com/channels/staffpicks/76979871', 'vimeo:76979871'],
    ['vimeo', 'https://vimeo.com/showcase/1234567/video/76979871', 'vimeo:76979871'],
    ['vimeo', 'https://vimeo.com/showcase/1234567', null],
    ['vimeo', 'https://vimeo.com/76979871/abcdef1234', 'vimeo:76979871'],
    ['vimeo', 'https://player.vimeo.com/video/76979871?h=abc', 'vimeo:76979871'],
    ['invidious', 'https://yewtu.be/watch?v=dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
    ['invidious', 'https://inv.example.org/embed/dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
    ['piped', 'https://piped.example.org/watch?v=dQw4w9WgXcQ', 'yt:dQw4w9WgXcQ'],
    ['peertube', 'https://tilvids.com/w/9c9de5e8-0a1e-484a-b099-e80766180a6d', 'pt:tilvids.com:9c9de5e8-0a1e-484a-b099-e80766180a6d'],
    ['peertube', 'https://framatube.org/w/kkGMgK9ZtnKfYAgnEtQxbv', 'pt:framatube.org:kkGMgK9ZtnKfYAgnEtQxbv'],
    ['peertube', 'https://framatube.org/videos/watch/kkGMgK9ZtnKfYAgnEtQxbv', 'pt:framatube.org:kkGMgK9ZtnKfYAgnEtQxbv'],
    ['peertube', 'https://framatube.org/c/somechannel', null],
  ];
  for (const [svc, url, key] of cases) assert.equal(identifyVideo(svc, url), key, `${svc} ${url}`);
});

test('pages map to the right services', () => {
  assert.deepEqual(servicesForUrl('https://www.youtube.com/results?search_query=x').map((s) => s.id), ['youtube', 'youtube-search']);
  assert.equal(videoServiceForUrl('https://player.vimeo.com/video/1').id, 'vimeo');
  assert.equal(videoServiceForUrl('https://www.google.com/search?q=x'), null);
  assert.deepEqual(servicesForUrl('https://www.youtube.com.evil.net/watch?v=dQw4w9WgXcQ'), []);
});

test('search URLs → queries, for every engine', () => {
  const cases = [
    ['https://www.google.com/search?q=hermetic+corpus&hl=en', 'hermetic corpus', 'google'],
    ['https://www.google.co.jp/search?q=%E7%B6%9A%E3%81%8D', '続き', 'google'],
    ['https://www.youtube.com/results?search_query=fe8+speedrun', 'fe8 speedrun', 'youtube'],
    ['https://duckduckgo.com/?q=meshtastic&ia=web', 'meshtastic', 'duckduckgo'],
    ['https://www.bing.com/search?q=y', 'y', 'bing'],
    ['https://search.brave.com/search?q=z', 'z', 'brave'],
    ['https://kagi.com/search?q=k', 'k', 'kagi'],
    ['https://www.startpage.com/sp/search?query=tea', 'tea', 'startpage'],
    ['https://www.ecosia.org/search?method=index&q=trees', 'trees', 'ecosia'],
    ['https://www.qwant.com/?q=lyon&t=web', 'lyon', 'qwant'],
    ['https://www.mojeek.com/search?q=indie', 'indie', 'mojeek'],
    ['https://search.yahoo.com/search?p=weather', 'weather', 'yahoo'],
    ['https://search.yahoo.co.jp/search?p=%E6%9D%B1%E4%BA%AC', '東京', 'yahoo-japan'],
    ['https://yandex.com/search/?text=borscht', 'borscht', 'yandex'],
    ['https://www.baidu.com/s?wd=%E5%8C%97%E4%BA%AC', '北京', 'baidu'],
    ['https://search.naver.com/search.naver?query=kimchi', 'kimchi', 'naver'],
  ];
  for (const [url, q, src] of cases) {
    const r = searchFromUrl(url);
    assert.equal(r?.q, q, url);
    assert.equal(r.src, src, url);
  }
  for (const url of [
    'https://www.google.com/maps?q=tokyo',
    'https://www.google.com/search?q=+++',
    'https://google.evil.com/search?q=x',
    'https://www.qwant.com/maps?q=x',
    'https://duckduckgo.com/',
  ]) assert.equal(searchFromUrl(url), null, url);
});

test('engines that POST the query fall back to the results page search box', () => {
  assert.deepEqual(searchFromUrl('https://html.duckduckgo.com/html/'), { needsInput: 'input[name="q"]', src: 'duckduckgo', service: 'duckduckgo' });
  assert.deepEqual(searchFromUrl('https://lite.duckduckgo.com/lite/'), { needsInput: 'input[name="q"]', src: 'duckduckgo', service: 'duckduckgo' });
  assert.equal(searchFromUrl('https://www.startpage.com/sp/search').needsInput, 'input[name="query"]');
  assert.equal(searchFromUrl('https://www.startpage.com/'), null, 'home page is not a results page');
});

test('instances: URL validation, searches, links', () => {
  assert.deepEqual(normalizeInstanceUrl('yewtu.be'), { origin: 'https://yewtu.be', host: 'yewtu.be', pattern: 'https://yewtu.be/*' });
  assert.deepEqual(normalizeInstanceUrl('https://search.example.org:8443/foo'), { origin: 'https://search.example.org:8443', host: 'search.example.org:8443', pattern: 'https://search.example.org/*' });
  assert.equal(normalizeInstanceUrl('http://localhost:8888').origin, 'http://localhost:8888');
  assert.throws(() => normalizeInstanceUrl('http://example.org'), /https/);
  assert.throws(() => normalizeInstanceUrl('not a host'), /server address/);

  assert.deepEqual(instanceSearchFromUrl('searxng', 'https://searx.example.org/search?q=privacy'), { q: 'privacy', src: 'searxng:searx.example.org' });
  assert.deepEqual(instanceSearchFromUrl('searxng', 'https://searx.example.org/search'), { needsInput: 'input[name="q"]', src: 'searxng:searx.example.org' });
  assert.deepEqual(instanceSearchFromUrl('invidious', 'https://yewtu.be/search?q=fe8'), { q: 'fe8', src: 'invidious:yewtu.be' });
  assert.deepEqual(instanceSearchFromUrl('peertube', 'https://tilvids.com/search?search=linux'), { q: 'linux', src: 'peertube:tilvids.com' });
  assert.equal(instanceSearchFromUrl('peertube', 'https://tilvids.com/w/abcdefghij'), null);
  assert.equal(Object.keys(INSTANCE_TYPES).length, 4);
});

test('links and labels for every key and source', () => {
  assert.equal(linkForKey('yt:dQw4w9WgXcQ', 90), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s');
  assert.equal(linkForKey('nebula:some-video'), 'https://nebula.tv/videos/some-video');
  assert.equal(linkForKey('twitch:2283745519'), 'https://www.twitch.tv/videos/2283745519');
  assert.equal(linkForKey('vimeo:76979871'), 'https://vimeo.com/76979871');
  assert.equal(linkForKey('pt:framatube.org:kkGMgK9ZtnKfYAgnEtQxbv'), 'https://framatube.org/w/kkGMgK9ZtnKfYAgnEtQxbv');
  assert.equal(linkForKey('pt:evil.org/@x:abcdefghij'), null, 'junk hosts never become links');
  assert.equal(linkForKey('nebula:../../x'), null);
  assert.equal(labelForKey('pt:framatube.org:kkGMgK9ZtnKfYAgnEtQxbv'), 'PeerTube · framatube.org');
  assert.equal(labelForKey('twitch:1'), 'Twitch');

  assert.equal(labelForSrc('yahoo-japan'), 'Yahoo! JAPAN');
  assert.equal(labelForSrc('searxng:searx.example.org'), 'SearXNG · searx.example.org');
  assert.equal(searchLinkFor('startpage', 'a b&c'), 'https://www.startpage.com/sp/search?query=a%20b%26c');
  assert.equal(searchLinkFor('searxng:searx.example.org', 'x'), 'https://searx.example.org/search?q=x');
  assert.equal(searchLinkFor('piped:p.example.org', 'x'), 'https://p.example.org/results?search_query=x');
  assert.equal(searchLinkFor('mystery', 'x'), 'https://duckduckgo.com/?q=x');
});

test('search targets follow the toggles and instances', () => {
  const t = searchTargets({ bing: false, ecosia: true }, [
    { origin: 'https://searx.example.org', type: 'searxng', enabled: true },
    { origin: 'https://yewtu.be', type: 'invidious', enabled: false },
  ]);
  const srcs = t.map((x) => x.src);
  assert.ok(srcs.includes('google') && srcs.includes('ecosia') && srcs.includes('searxng:searx.example.org'));
  assert.ok(!srcs.includes('bing') && !srcs.includes('naver') && !srcs.includes('invidious:yewtu.be'));
});

test('manifest content scripts cover every service', () => {
  const cs = manifestContentScripts();
  const all = cs.flatMap((c) => c.matches);
  for (const s of SERVICES) for (const m of s.matches) assert.ok(all.includes(m), m);
  assert.ok(cs.some((c) => c.all_frames && c.matches.includes('*://player.vimeo.com/video/*')));
});
