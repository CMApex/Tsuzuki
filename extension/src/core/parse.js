// URL parsing for the sites Tsuzuki understands. Pure functions, no DOM.

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$/;

function toUrl(input) {
  try {
    return input instanceof URL ? input : new URL(String(input));
  } catch {
    return null;
  }
}

/**
 * Identify a YouTube video from a URL.
 * Returns { id, key, kind } where kind is 'watch' | 'shorts' | 'live' | 'embed', or null.
 */
export function youtubeVideo(input) {
  const url = toUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  let id = null;
  let kind = 'watch';

  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (YT_HOSTS.test(host)) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'live', 'embed'].includes(parts[0])) {
      kind = parts[0];
      id = parts[1];
    }
  }
  if (!id || !YT_ID.test(id)) return null;
  return { id, key: `yt:${id}`, kind };
}

/** Seconds from a YouTube `t`/`start` parameter ("90", "90s", "1h2m3s"), or null. */
export function youtubeStartTime(input) {
  const url = toUrl(input);
  if (!url) return null;
  const raw = url.searchParams.get('t') ?? url.searchParams.get('start') ?? url.hash.match(/t=([^&]+)/)?.[1];
  if (!raw) return null;
  if (/^\d+s?$/.test(raw)) return parseInt(raw, 10);
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

/** Canonical link back to a video, optionally at a timestamp. */
export function youtubeLink(key, seconds) {
  const id = key.startsWith('yt:') ? key.slice(3) : key;
  const t = seconds > 0 ? `&t=${Math.floor(seconds)}s` : '';
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}${t}`;
}

// ---------------------------------------------------------------------------
// Search engines
// ---------------------------------------------------------------------------

const ENGINES = [
  { src: 'google', host: /(^|\.)google\.[a-z.]{2,6}$/, path: /^\/search$/, param: 'q', url: (q) => `https://www.google.com/search?q=${q}` },
  { src: 'youtube', host: YT_HOSTS, path: /^\/results$/, param: 'search_query', url: (q) => `https://www.youtube.com/results?search_query=${q}` },
  { src: 'duckduckgo', host: /(^|\.)duckduckgo\.com$/, path: /^\/(html\/?|lite\/?)?$/, param: 'q', url: (q) => `https://duckduckgo.com/?q=${q}` },
  { src: 'bing', host: /(^|\.)bing\.com$/, path: /^\/search$/, param: 'q', url: (q) => `https://www.bing.com/search?q=${q}` },
  { src: 'brave', host: /^search\.brave\.com$/, path: /^\/search$/, param: 'q', url: (q) => `https://search.brave.com/search?q=${q}` },
  { src: 'kagi', host: /^kagi\.com$/, path: /^\/search$/, param: 'q', url: (q) => `https://kagi.com/search?q=${q}` },
];

export const SEARCH_SOURCES = Object.freeze(ENGINES.map((e) => e.src));

/** Extract { q, src } from a search-results URL, or null. */
export function searchFromUrl(input) {
  const url = toUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  for (const e of ENGINES) {
    if (!e.host.test(host) || !e.path.test(url.pathname)) continue;
    const q = (url.searchParams.get(e.param) || '').trim();
    return q ? { q, src: e.src } : null;
  }
  return null;
}

/** Link to re-run a remembered search on the engine it came from. */
export function searchLink(q, src) {
  const e = ENGINES.find((x) => x.src === src) || ENGINES[0];
  return e.url(encodeURIComponent(q));
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
