// SPDX-License-Identifier: AGPL-3.0-or-later
// Every site Tsuzuki understands, in one table. The manifest, the per-service
// toggles, the content scripts, the links in the popup and "search again on…"
// are all generated from this file. Pure functions, no DOM.

import { isYoutubeId, toUrl, youtubeLink, youtubeVideo } from './parse.js';

export const VIDEO = 'video';
export const SEARCH = 'search';

const GOOGLE_TLDS = [
  'com', 'co.uk', 'ca', 'com.au', 'co.nz', 'ie', 'de', 'at', 'ch', 'fr', 'be', 'nl', 'es', 'it', 'pt', 'pl', 'se',
  'no', 'dk', 'fi', 'co.jp', 'co.kr', 'com.tw', 'com.hk', 'co.in', 'com.br', 'com.mx', 'com.ar', 'co.za',
];

// ---------------------------------------------------------------------------
// Video identification
// ---------------------------------------------------------------------------

function youtubeKey(url) {
  const v = youtubeVideo(url);
  return v && v.kind !== 'shorts' ? v.key : null; // Shorts loop forever; not worth remembering
}

function nebulaKey(url) {
  const m = url.pathname.match(/^\/videos\/([a-z0-9][a-z0-9-]{1,150})\/?$/i);
  return m ? `nebula:${m[1].toLowerCase()}` : null;
}

function twitchKey(url) {
  const m = url.pathname.match(/^\/videos\/(\d{5,15})\/?$/);
  return m ? `twitch:${m[1]}` : null;
}

const VIMEO_NOT_A_VIDEO = new Set(['showcase', 'album', 'groups', 'channels', 'user', 'categories', 'ondemand', 'blog']);

function vimeoKey(url) {
  if (url.hostname === 'player.vimeo.com') {
    const m = url.pathname.match(/^\/video\/(\d{5,12})\/?$/);
    return m ? `vimeo:${m[1]}` : null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if (/^\d{5,12}$/.test(parts[i]) && !VIMEO_NOT_A_VIDEO.has(parts[i - 1])) return `vimeo:${parts[i]}`;
  }
  return null;
}

/** YouTube front-ends (Invidious, Piped) use YouTube's own ids, so their history is YouTube's history. */
function frontendKey(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (parts[0] === 'watch') id = url.searchParams.get('v');
  else if (['embed', 'v', 'w', 'latest_version'].includes(parts[0])) id = parts[1] || url.searchParams.get('id');
  return isYoutubeId(id) ? `yt:${id}` : null;
}

const PEERTUBE_ID = /^[A-Za-z0-9-]{8,40}$/;

function peertubeKey(url) {
  const m = url.pathname.match(/^\/(?:w|videos\/watch|videos\/embed)\/([^/]+)\/?$/);
  return m && PEERTUBE_ID.test(m[1]) ? `pt:${url.host}:${m[1]}` : null;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const SERVICES = Object.freeze([
  // Video ----------------------------------------------------------------
  {
    id: 'youtube', kind: VIDEO, keyPrefix: 'yt:', label: 'YouTube', default: true,
    host: /^(www|m)\.youtube\.com$/,
    matches: ['*://www.youtube.com/*', '*://m.youtube.com/*'],
    identify: youtubeKey, thumbs: 'a[href*="/watch?v="]', navEvents: ['yt-navigate-finish'],
  },
  {
    id: 'youtube-music', kind: VIDEO, keyPrefix: 'yt:', label: 'YouTube Music', default: true,
    host: /^music\.youtube\.com$/,
    matches: ['*://music.youtube.com/*'],
    identify: youtubeKey,
  },
  {
    id: 'nebula', kind: VIDEO, keyPrefix: 'nebula:', label: 'Nebula', default: false,
    host: /^nebula\.tv$/,
    matches: ['*://nebula.tv/*'],
    identify: nebulaKey, thumbs: 'a[href*="/videos/"]',
  },
  {
    id: 'twitch', kind: VIDEO, keyPrefix: 'twitch:', label: 'Twitch VODs', default: false,
    host: /^(www|m)\.twitch\.tv$/,
    matches: ['*://www.twitch.tv/*', '*://m.twitch.tv/*'],
    identify: twitchKey, thumbs: 'a[href*="/videos/"]',
  },
  {
    id: 'vimeo', kind: VIDEO, keyPrefix: 'vimeo:', label: 'Vimeo', default: false,
    host: /^(player\.)?vimeo\.com$/,
    matches: ['*://vimeo.com/*'],
    // Vimeo embeds are iframes from player.vimeo.com, on vimeo.com and everywhere else.
    frameMatches: ['*://player.vimeo.com/video/*'],
    identify: vimeoKey,
  },

  // Search ---------------------------------------------------------------
  // `src` is what gets stored on each search record.
  {
    id: 'google', kind: SEARCH, label: 'Google', src: 'google', default: true,
    host: /^www\.google\.[a-z]{2,3}(\.[a-z]{2})?$/, path: /^\/search$/, param: 'q',
    url: 'https://www.google.com/search?q=',
    matches: GOOGLE_TLDS.map((t) => `*://www.google.${t}/search*`),
  },
  {
    // Rides along with the YouTube video script, so it needs no matches of its own.
    id: 'youtube-search', kind: SEARCH, label: 'YouTube', src: 'youtube', default: true,
    host: /^(www|m)\.youtube\.com$/, path: /^\/results$/, param: 'search_query',
    url: 'https://www.youtube.com/results?search_query=',
    matches: [],
  },
  {
    id: 'duckduckgo', kind: SEARCH, label: 'DuckDuckGo', src: 'duckduckgo', default: true,
    host: /^(html\.|lite\.)?duckduckgo\.com$/, path: /^\/(html\/?|lite\/?)?$/, param: 'q',
    // The HTML and Lite versions POST the query, so it's read from the results page's search box.
    input: 'input[name="q"]',
    inputHost: /^(html|lite)\.duckduckgo\.com$/, // on duckduckgo.com itself, "/" is just the home page
    url: 'https://duckduckgo.com/?q=',
    matches: ['*://duckduckgo.com/*', '*://html.duckduckgo.com/*', '*://lite.duckduckgo.com/*'],
  },
  {
    id: 'bing', kind: SEARCH, label: 'Bing', src: 'bing', default: true,
    host: /^www\.bing\.com$/, path: /^\/search$/, param: 'q',
    url: 'https://www.bing.com/search?q=',
    matches: ['*://www.bing.com/search*'],
  },
  {
    id: 'brave', kind: SEARCH, label: 'Brave Search', src: 'brave', default: true,
    host: /^search\.brave\.com$/, path: /^\/search$/, param: 'q',
    url: 'https://search.brave.com/search?q=',
    matches: ['*://search.brave.com/search*'],
  },
  {
    id: 'kagi', kind: SEARCH, label: 'Kagi', src: 'kagi', default: true,
    host: /^kagi\.com$/, path: /^\/search$/, param: 'q',
    url: 'https://kagi.com/search?q=',
    matches: ['*://kagi.com/search*'],
  },
  {
    id: 'startpage', kind: SEARCH, label: 'Startpage', src: 'startpage', default: false,
    host: /^(www\.|eu\.|us\.)?startpage\.com$/, path: /^\/(sp\/search|do\/(d|m|as)?search)$/, param: 'query',
    input: 'input[name="query"]', // Startpage POSTs by default
    url: 'https://www.startpage.com/sp/search?query=',
    matches: ['*://www.startpage.com/*', '*://startpage.com/*', '*://eu.startpage.com/*', '*://us.startpage.com/*'],
  },
  {
    id: 'ecosia', kind: SEARCH, label: 'Ecosia', src: 'ecosia', default: false,
    host: /^www\.ecosia\.org$/, path: /^\/search$/, param: 'q',
    url: 'https://www.ecosia.org/search?q=',
    matches: ['*://www.ecosia.org/search*'],
  },
  {
    id: 'qwant', kind: SEARCH, label: 'Qwant', src: 'qwant', default: false,
    host: /^www\.qwant\.com$/, path: /^\/$/, param: 'q',
    url: 'https://www.qwant.com/?q=',
    matches: ['*://www.qwant.com/*'],
  },
  {
    id: 'mojeek', kind: SEARCH, label: 'Mojeek', src: 'mojeek', default: false,
    host: /^www\.mojeek\.com$/, path: /^\/search$/, param: 'q',
    url: 'https://www.mojeek.com/search?q=',
    matches: ['*://www.mojeek.com/search*'],
  },
  {
    id: 'yahoo', kind: SEARCH, label: 'Yahoo', src: 'yahoo', default: false,
    host: /^search\.yahoo\.com$/, path: /^\/search\/?$/, param: 'p',
    url: 'https://search.yahoo.com/search?p=',
    matches: ['*://search.yahoo.com/search*'],
  },
  {
    id: 'yahoo-japan', kind: SEARCH, label: 'Yahoo! JAPAN', src: 'yahoo-japan', default: false,
    host: /^search\.yahoo\.co\.jp$/, path: /^\/search\/?$/, param: 'p',
    url: 'https://search.yahoo.co.jp/search?p=',
    matches: ['*://search.yahoo.co.jp/search*'],
  },
  {
    id: 'yandex', kind: SEARCH, label: 'Yandex', src: 'yandex', default: false,
    host: /^(www\.)?yandex\.(com|ru)$/, path: /^\/search\/?$/, param: 'text',
    url: 'https://yandex.com/search/?text=',
    matches: ['*://yandex.com/search*', '*://www.yandex.com/search*', '*://yandex.ru/search*', '*://www.yandex.ru/search*'],
  },
  {
    id: 'baidu', kind: SEARCH, label: 'Baidu', src: 'baidu', default: false,
    host: /^www\.baidu\.com$/, path: /^\/s$/, param: 'wd',
    url: 'https://www.baidu.com/s?wd=',
    matches: ['*://www.baidu.com/s*'],
  },
  {
    id: 'naver', kind: SEARCH, label: 'Naver', src: 'naver', default: false,
    host: /^search\.naver\.com$/, path: /^\/search\.naver$/, param: 'query',
    url: 'https://search.naver.com/search.naver?query=',
    matches: ['*://search.naver.com/search.naver*'],
  },
]);

/** Self-hosted / federated services the user adds by URL. */
export const INSTANCE_TYPES = Object.freeze({
  invidious: {
    label: 'Invidious', video: true, keyPrefix: () => 'yt:', identify: frontendKey, thumbs: 'a[href*="/watch?v="]',
    search: { path: /^\/search$/, param: 'q', url: (origin) => `${origin}/search?q=` },
  },
  piped: {
    label: 'Piped', video: true, keyPrefix: () => 'yt:', identify: frontendKey, thumbs: 'a[href*="/watch?v="]',
    search: { path: /^\/results$/, param: 'search_query', url: (origin) => `${origin}/results?search_query=` },
  },
  peertube: {
    label: 'PeerTube', video: true, keyPrefix: (host) => `pt:${host}:`, identify: peertubeKey, thumbs: 'a[href*="/w/"], a[href*="/videos/watch/"]',
    search: { path: /^\/search$/, param: 'search', url: (origin) => `${origin}/search?search=` },
  },
  searxng: {
    label: 'SearXNG', video: false,
    // Many SearXNG instances POST by default.
    search: { path: /^\/search$/, param: 'q', input: 'input[name="q"]', url: (origin) => `${origin}/search?q=` },
  },
});

const BY_ID = new Map(SERVICES.map((s) => [s.id, s]));
const BY_SRC = new Map(SERVICES.filter((s) => s.kind === SEARCH).map((s) => [s.src, s]));

export function searchServiceBySrc(src) {
  return BY_SRC.get(src) || null;
}

/** Match pattern for an instance origin's host permission. */
export function instancePattern(origin) {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

export function serviceById(id) {
  return BY_ID.get(id) || null;
}

export const DEFAULT_SERVICES = Object.freeze(Object.fromEntries(SERVICES.map((s) => [s.id, s.default])));

/** Enabled flags with defaults filled in for anything the user hasn't set. */
export function resolveServices(stored = {}) {
  const out = {};
  for (const s of SERVICES) out[s.id] = typeof stored[s.id] === 'boolean' ? stored[s.id] : s.default;
  return out;
}

// ---------------------------------------------------------------------------
// Matching URLs to services
// ---------------------------------------------------------------------------

/** Static services whose host matches this URL (a page can belong to a video and a search service). */
export function servicesForUrl(input) {
  const url = toUrl(input);
  if (!url) return [];
  const host = url.hostname.toLowerCase();
  return SERVICES.filter((s) => s.host.test(host));
}

export function videoServiceForUrl(input) {
  return servicesForUrl(input).find((s) => s.kind === VIDEO) || null;
}

/** Key of the video at `input` for a static service id or an instance type, or null. */
export function identifyVideo(serviceOrType, input) {
  const url = toUrl(input);
  if (!url) return null;
  const def = BY_ID.get(serviceOrType) || INSTANCE_TYPES[serviceOrType];
  if (!def?.identify) return null;
  return def.identify(url);
}

function queryFrom(url, { path, param }) {
  if (!path.test(url.pathname)) return null;
  return (url.searchParams.get(param) || '').trim();
}

/**
 * For a static search engine's results page: { q, src, service } if the query is in the URL,
 * { needsInput: selector, src, service } if the engine POSTed it, else null.
 */
export function searchFromUrl(input) {
  const url = toUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  for (const s of SERVICES) {
    if (s.kind !== SEARCH || !s.host.test(host)) continue;
    const q = queryFrom(url, s);
    if (q === null) continue;
    if (q) return { q, src: s.src, service: s.id };
    if (s.input && (!s.inputHost || s.inputHost.test(host))) return { needsInput: s.input, src: s.src, service: s.id };
  }
  return null;
}

/** Same as searchFromUrl, for a user-added instance. */
export function instanceSearchFromUrl(type, input) {
  const url = toUrl(input);
  const t = INSTANCE_TYPES[type];
  if (!url || !t) return null;
  const q = queryFrom(url, t.search);
  if (q === null) return null;
  const src = `${type}:${url.host}`;
  if (q) return { q, src };
  if (t.search.input) return { needsInput: t.search.input, src };
  return null;
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/**
 * Validate a user-entered instance URL. Returns { origin, host, pattern } where
 * pattern is the host-permission match pattern to request.
 */
export function normalizeInstanceUrl(input) {
  const raw = String(input || '').trim();
  const url = toUrl(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!url || (!url.hostname.includes('.') && url.hostname !== 'localhost')) throw new Error("That doesn't look like a server address.");
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.local');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Instances need https:// (http is only allowed for localhost / .local).');
  return { origin: url.origin, host: url.host, pattern: `${url.protocol}//${url.hostname}/*` };
}

// ---------------------------------------------------------------------------
// Links & labels for the popup
// ---------------------------------------------------------------------------

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/** Where to open a remembered video. Tsuzuki resumes it on arrival, so most links carry no timestamp. */
export function linkForKey(key, seconds = 0) {
  const [prefix, ...rest] = key.split(':');
  const id = rest.join(':');
  switch (prefix) {
    case 'yt':
      return youtubeLink(key, seconds);
    case 'nebula':
      return /^[a-z0-9-]+$/.test(id) ? `https://nebula.tv/videos/${id}` : null;
    case 'twitch':
      return /^\d+$/.test(id) ? `https://www.twitch.tv/videos/${id}` : null;
    case 'vimeo':
      return /^\d+$/.test(id) ? `https://vimeo.com/${id}` : null;
    case 'pt': {
      const host = rest.slice(0, -1).join(':');
      const vid = rest.at(-1);
      return HOST_RE.test(host) && PEERTUBE_ID.test(vid) ? `https://${host}/w/${vid}` : null;
    }
    default:
      return null;
  }
}

export function labelForKey(key) {
  const prefix = key.split(':')[0];
  if (prefix === 'pt') return `PeerTube · ${key.split(':').slice(1, -1).join(':')}`;
  return { yt: 'YouTube', nebula: 'Nebula', twitch: 'Twitch', vimeo: 'Vimeo' }[prefix] || prefix;
}

/** Label for a stored search `src` ("duckduckgo", "searxng:search.example.org", …). */
export function labelForSrc(src) {
  const s = BY_SRC.get(src);
  if (s) return s.label;
  const [type, ...host] = String(src).split(':');
  return INSTANCE_TYPES[type] ? `${INSTANCE_TYPES[type].label} · ${host.join(':')}` : src;
}

/** Link to run `q` on `src`. Unknown sources fall back to DuckDuckGo. */
export function searchLinkFor(src, q) {
  const enc = encodeURIComponent(q);
  const s = BY_SRC.get(src);
  if (s) return s.url + enc;
  const [type, ...rest] = String(src).split(':');
  const host = rest.join(':');
  if (INSTANCE_TYPES[type] && HOST_RE.test(host)) return INSTANCE_TYPES[type].search.url(`https://${host}`) + enc;
  return BY_SRC.get('duckduckgo').url + enc;
}

/**
 * Engines offered under "search again on…": every enabled search service plus
 * every enabled instance (each instance type has a search page).
 */
export function searchTargets(services, instances = []) {
  const enabled = resolveServices(services);
  const out = SERVICES.filter((s) => s.kind === SEARCH && enabled[s.id]).map((s) => ({ src: s.src, label: s.label }));
  for (const inst of instances) {
    if (!inst.enabled || !INSTANCE_TYPES[inst.type]) continue;
    const host = new URL(inst.origin).host;
    const src = `${inst.type}:${host}`;
    out.push({ src, label: labelForSrc(src) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bangs (home page search box): "!yt fire emblem" or "fire emblem !yt"
// ---------------------------------------------------------------------------

export const BANGS = Object.freeze({
  g: 'google', yt: 'youtube', d: 'duckduckgo', ddg: 'duckduckgo', b: 'bing', br: 'brave', k: 'kagi', sp: 'startpage',
  eco: 'ecosia', qw: 'qwant', mj: 'mojeek', y: 'yahoo', yj: 'yahoo-japan', ya: 'yandex', bd: 'baidu', nv: 'naver',
});
export const INSTANCE_BANGS = Object.freeze({ sx: 'searxng', inv: 'invidious', pi: 'piped', pt: 'peertube' });

/**
 * Split a bang out of a query. Returns { q, src } where src is null if there was
 * no bang (or an unknown one, which then stays part of the query).
 */
export function parseBang(raw, instances = []) {
  const text = String(raw || '');
  const m = text.match(/(^|\s)!([a-z][a-z-]*)(?=\s|$)/i);
  if (m) {
    const bang = m[2].toLowerCase();
    let src = BANGS[bang] || (BY_SRC.has(bang) ? bang : null);
    if (!src && INSTANCE_BANGS[bang]) {
      const inst = instances.find((i) => i.enabled && i.type === INSTANCE_BANGS[bang]);
      if (inst) src = `${inst.type}:${new URL(inst.origin).host}`;
    }
    if (src) {
      const q = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).trim().replace(/\s+/g, ' ');
      return { q, src };
    }
  }
  return { q: text.trim(), src: null };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function manifestContentScripts() {
  const video = SERVICES.filter((s) => s.kind === VIDEO);
  const search = SERVICES.filter((s) => s.kind === SEARCH);
  return [
    { matches: video.flatMap((s) => s.matches), js: ['content/video.js'], run_at: 'document_idle' },
    {
      matches: video.flatMap((s) => s.frameMatches || []),
      js: ['content/video.js'],
      run_at: 'document_idle',
      all_frames: true,
    },
    { matches: search.flatMap((s) => s.matches), js: ['content/search.js'], run_at: 'document_end' },
  ].filter((cs) => cs.matches.length);
}
