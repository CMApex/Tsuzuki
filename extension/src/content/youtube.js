// YouTube content script: resume points, watched tracking, thumbnail progress bars,
// and YouTube search capture. Works on www.youtube.com and m.youtube.com.

import { formatTime, searchFromUrl, youtubeStartTime, youtubeVideo } from '../core/parse.js';
import { isPrivate, rpc } from './rpc.js';

const TICK_MS = 10_000;
const MIN_RESUME = 15;
const END_GUARD = 25;
const ACCENT = '#e4572e';

let features = { recording: true, resume: true, badges: true, searches: true };
let current = null; // the video we're tracking on this page
let lastHref = '';
let boundVideo = null;
let lastTrackedSrc = null; // media src of the previously tracked video (to detect the swap on SPA nav)

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

function findVideo() {
  return (
    document.querySelector('#movie_player video') ||
    document.querySelector('#player-container-id video') ||
    document.querySelector('video.html5-main-video') ||
    document.querySelector('ytm-player video, video')
  );
}

function adShowing() {
  return !!document.querySelector('.ad-showing, .ad-interrupting');
}

function text(sel) {
  const el = document.querySelector(sel);
  return el ? el.textContent.trim().replace(/\s+/g, ' ') : '';
}

function videoTitle() {
  return (
    text('ytd-watch-metadata h1') ||
    text('h1.ytd-watch-metadata') ||
    text('.slim-video-information-title') ||
    text('.slim-video-metadata-header h2') ||
    document.title.replace(/^\(\d+\)\s*/, '').replace(/\s+-\s+YouTube$/, '')
  );
}

function channelName() {
  return (
    text('ytd-watch-metadata ytd-channel-name a') ||
    text('#owner ytd-channel-name a') ||
    text('.slim-owner-channel-name') ||
    text('ytm-slim-owner-renderer .YtmBadgeAndBylineRendererItemByline')
  );
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

function onUrlMaybeChanged() {
  const href = location.href;
  if (href === lastHref) return;
  lastHref = href;

  if (features.searches) {
    const s = searchFromUrl(href);
    if (s && s.src === 'youtube') rpc({ type: 'search', ...s });
  }

  const v = youtubeVideo(href);
  if (current && (!v || v.key !== current.key)) {
    flush();
    current = null;
  }
  if (v && v.kind !== 'shorts' && (!current || current.key !== v.key)) {
    current = {
      key: v.key,
      ready: false,
      // Don't override an explicit timestamp (&t=...) — the link already says where to start.
      resumeDone: !features.resume || youtubeStartTime(href) !== null,
      resumeAsked: false,
      staleSrc: lastTrackedSrc,
      t: 0,
      dur: 0,
      lastSentAt: 0,
      lastSentT: -1,
    };
    bindVideo();
  }
}

function bindVideo() {
  const el = findVideo();
  if (!el) {
    // Player not in the DOM yet; the 1s poll retries.
    return;
  }
  if (el === boundVideo) return;
  boundVideo = el;
  el.addEventListener('timeupdate', onTimeUpdate);
  el.addEventListener('loadedmetadata', onTimeUpdate);
  el.addEventListener('pause', () => onTimeUpdate(true));
  el.addEventListener('seeked', () => onTimeUpdate(false));
  el.addEventListener('ended', () => {
    if (current?.ready && !adShowing()) send(true);
  });
}

/** The <video> element is reused across SPA navigations; wait until it's really showing the new video. */
function checkReady(el) {
  if (current.ready) return true;
  if (el.readyState < 1 || !el.currentSrc || adShowing()) return false;
  if (current.staleSrc && el.currentSrc === current.staleSrc) return false;
  current.ready = true;
  return true;
}

function onTimeUpdate(forceSend = false) {
  const el = boundVideo;
  if (!current || !el || !checkReady(el) || adShowing()) return;
  const dur = el.duration;
  if (!Number.isFinite(dur) || dur <= 0) return; // live streams have no end and no resume point
  current.t = el.currentTime;
  current.dur = dur;
  lastTrackedSrc = el.currentSrc;

  if (!current.resumeDone) {
    if (!current.resumeAsked) maybeResume(el);
    return; // don't record progress until we know whether to jump
  }
  const due = Date.now() - current.lastSentAt >= TICK_MS && !el.paused;
  if (forceSend === true || due) send(false);
}

async function maybeResume(el) {
  const cur = current;
  cur.resumeAsked = true;
  const r = await rpc({ type: 'getResume', key: cur.key });
  if (cur !== current) return;
  cur.resumeDone = true;
  if (!r || r.t < MIN_RESUME || r.t > cur.dur - END_GUARD) return;
  if (el.currentTime >= r.t - 5) return; // already there, or the viewer skipped ahead
  const from = el.currentTime;
  el.currentTime = r.t;
  toast(`続き · Resumed at ${formatTime(r.t)}`, 'Start over', () => {
    el.currentTime = from < MIN_RESUME ? 0 : from;
  });
  // YouTube occasionally snaps back right after a programmatic seek; nudge once more.
  setTimeout(() => {
    if (cur === current && el.currentTime < r.t - 10) el.currentTime = r.t;
  }, 1500);
}

function send(ended) {
  if (!current || !current.ready || !current.resumeDone || !(current.dur > 0)) return;
  if (!ended && Math.abs(current.t - current.lastSentT) < 1) return;
  current.lastSentAt = Date.now();
  current.lastSentT = current.t;
  badgeCache.delete(current.key);
  rpc({
    type: 'progress',
    key: current.key,
    t: ended ? current.dur : current.t,
    dur: current.dur,
    title: videoTitle(),
    ch: channelName(),
    ended,
  });
}

/** Record the latest position right now (navigation, tab hidden, page closing). */
function flush() {
  const el = boundVideo;
  if (current && el && current.ready && !adShowing() && el.currentSrc === lastTrackedSrc && Number.isFinite(el.duration)) {
    current.t = el.currentTime;
  }
  send(false);
}

// ---------------------------------------------------------------------------
// Toast (closed shadow root so the page can't read it)
// ---------------------------------------------------------------------------

function toast(message, actionLabel, onAction) {
  const host = document.createElement('tsz-toast');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .t{position:fixed;left:16px;bottom:24px;z-index:2147483647;display:flex;gap:12px;align-items:center;
      padding:10px 14px;border-radius:10px;background:#1c1915;color:#f3ece0;font:500 14px/1.3 system-ui,sans-serif;
      box-shadow:0 6px 24px rgba(0,0,0,.35);border-left:3px solid ${ACCENT};opacity:0;transform:translateY(8px);
      transition:opacity .2s, transform .2s}
    .t.on{opacity:1;transform:none}
    button{all:unset;cursor:pointer;color:${ACCENT};font-weight:600}
    button:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px}`;
  const box = document.createElement('div');
  box.className = 't';
  box.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.textContent = message;
  const btn = document.createElement('button');
  btn.textContent = actionLabel;
  btn.addEventListener('click', () => {
    onAction();
    host.remove();
  });
  box.append(msg, btn);
  root.append(style, box);
  document.documentElement.append(host);
  requestAnimationFrame(() => box.classList.add('on'));
  setTimeout(() => host.remove(), 7000);
}

// ---------------------------------------------------------------------------
// Thumbnail progress bars
//
// A marker is mounted on *every* thumbnail, whether or not you've seen it, and
// the bar lives in a closed shadow root. That way YouTube's own scripts can't
// learn your local history just by looking at which thumbnails got decorated.
// ---------------------------------------------------------------------------

const marks = new Set(); // { anchor, host, bar, key }
const markByAnchor = new WeakMap();
const badgeCache = new Map(); // key -> { info, at }
const BADGE_TTL = 60_000;

function mount(anchor) {
  const host = document.createElement('tsz-mark');
  host.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:4px;pointer-events:none;z-index:3;display:block';
  const root = host.attachShadow({ mode: 'closed' });
  const bar = document.createElement('div');
  bar.style.cssText = `height:100%;width:0;background:${ACCENT};border-radius:0 2px 2px 0`;
  root.append(bar);
  if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
  anchor.append(host);
  const m = { anchor, host, bar, key: null };
  marks.add(m);
  markByAnchor.set(anchor, m);
  return m;
}

function paint(m) {
  const info = badgeCache.get(m.key)?.info;
  m.bar.style.width = info ? `${Math.max(3, Math.round(info.p * 100))}%` : '0';
}

let fetching = false;

async function scanThumbnails() {
  const need = new Set();
  const now = Date.now();
  for (const a of document.querySelectorAll('a[href*="/watch?v="]')) {
    if (!a.querySelector('img')) continue; // title links etc.
    const v = youtubeVideo(a.href);
    if (!v) continue;
    let m = markByAnchor.get(a);
    if (!m || m.host.parentNode !== a) m = mount(a);
    m.key = v.key; // YouTube recycles DOM nodes, so re-read the href every pass
    const cached = badgeCache.get(v.key);
    if (!cached || now - cached.at > BADGE_TTL) need.add(v.key);
    paint(m);
  }
  for (const m of marks) if (!m.anchor.isConnected) marks.delete(m);

  if (!need.size || fetching) return;
  fetching = true;
  try {
    const keys = [...need].slice(0, 200);
    const result = (await rpc({ type: 'getMany', keys })) || {};
    for (const k of keys) badgeCache.set(k, { info: result[k] || null, at: Date.now() });
    for (const m of marks) paint(m);
  } finally {
    fetching = false;
  }
}

function startBadges() {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      scanThumbnails();
    }, 700);
  };
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
  schedule();
}

// ---------------------------------------------------------------------------

async function init() {
  if (isPrivate) return;
  const f = await rpc({ type: 'features' });
  if (f) features = f;
  if (!features.recording) return;

  onUrlMaybeChanged();
  setInterval(() => {
    onUrlMaybeChanged();
    if (current && !boundVideo?.isConnected) {
      boundVideo = null;
      bindVideo();
    } else if (current && !boundVideo) bindVideo();
  }, 1000);
  document.addEventListener('yt-navigate-finish', onUrlMaybeChanged);
  window.addEventListener('popstate', onUrlMaybeChanged);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  if (features.badges) startBadges();
}

init();
