// SPDX-License-Identifier: AGPL-3.0-or-later
// Low-level URL helpers. Pure functions, no DOM. Site knowledge lives in services.js.

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$/;

export function toUrl(input, base) {
  try {
    return input instanceof URL ? input : new URL(String(input), base);
  } catch {
    return null;
  }
}

export function isYoutubeId(id) {
  return typeof id === 'string' && YT_ID.test(id);
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
  if (!isYoutubeId(id)) return null;
  return { id, key: `yt:${id}`, kind };
}

/** Seconds from a time spec: "90", "90s", "1h2m3s", "4m". Null if absent or malformed. */
export function parseTimeSpec(raw) {
  if (!raw) return null;
  if (/^\d+s?$/.test(raw)) return parseInt(raw, 10);
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

/** Explicit start time in a URL (`?t=`, `?start=`, `#t=`), or null. */
export function startTimeFromUrl(input) {
  const url = toUrl(input);
  if (!url) return null;
  return parseTimeSpec(url.searchParams.get('t') ?? url.searchParams.get('start') ?? url.hash.match(/t=([^&]+)/)?.[1]);
}

/** Kept for compatibility: the YouTube flavour is the generic one. */
export const youtubeStartTime = startTimeFromUrl;

/** Canonical link back to a YouTube video, optionally at a timestamp. */
export function youtubeLink(key, seconds) {
  const id = key.startsWith('yt:') ? key.slice(3) : key;
  const t = seconds > 0 ? `&t=${Math.floor(seconds)}s` : '';
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}${t}`;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
