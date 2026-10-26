// SPDX-License-Identifier: AGPL-3.0-or-later
// The site-independent video tracker: resume points, progress, "finished", and
// thumbnail progress bars. Each site supplies a small adapter (see adapters.js).

import { formatTime, startTimeFromUrl } from '../core/parse.js';
import { rpc } from './rpc.js';

const TICK_MS = 10_000;
const MIN_RESUME = 15;
const END_GUARD = 25;
const ACCENT = '#e4572e';
const BADGE_TTL = 60_000;

/**
 * @param {object} o
 * @param {string} o.service   service id sent with every message ("instance" on user-added instances)
 * @param {object} o.adapter   { identify(url)->key|null, findVideo(), adShowing(), title(), channel(), thumbs?, navEvents? }
 * @param {object} o.features  { resume, badges } from the background
 */
export function startVideoTracker({ service, adapter, features }) {
  let current = null; // the video being tracked on this page
  let lastHref = '';
  let boundVideo = null;
  let lastTrackedSrc = null; // media src of the previously tracked video (to spot the swap on SPA navigation)

  const send = (msg) => rpc({ service, ...msg });

  // ------------------------------------------------------------- tracking

  function onUrlMaybeChanged() {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;

    const key = adapter.identify(href);
    if (current && key !== current.key) {
      flush();
      current = null;
    }
    if (key && !current) {
      current = {
        key,
        ready: false,
        // Don't override an explicit timestamp (&t=...): the link already says where to start.
        resumeDone: !features.resume || startTimeFromUrl(href) !== null,
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
    const el = adapter.findVideo();
    if (!el || el === boundVideo) return; // not in the DOM yet: the 1s poll retries
    boundVideo = el;
    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('loadedmetadata', onTimeUpdate);
    el.addEventListener('pause', () => onTimeUpdate(true));
    el.addEventListener('seeked', () => onTimeUpdate(false));
    el.addEventListener('ended', () => {
      if (current?.ready && !adapter.adShowing()) report(true);
    });
  }

  /** Players are reused across SPA navigations; wait until the element really shows the new video. */
  function checkReady(el) {
    if (current.ready) return true;
    if (el.readyState < 1 || !el.currentSrc || adapter.adShowing()) return false;
    if (current.staleSrc && el.currentSrc === current.staleSrc) return false;
    current.ready = true;
    return true;
  }

  function onTimeUpdate(forceSend = false) {
    const el = boundVideo;
    if (!current || !el || !checkReady(el) || adapter.adShowing()) return;
    const dur = el.duration;
    if (!Number.isFinite(dur) || dur <= 0) return; // live streams: no end, no resume point
    current.t = el.currentTime;
    current.dur = dur;
    lastTrackedSrc = el.currentSrc;

    if (!current.resumeDone) {
      if (!current.resumeAsked) maybeResume(el);
      return; // don't record progress until we know whether to jump
    }
    const due = Date.now() - current.lastSentAt >= TICK_MS && !el.paused;
    if (forceSend === true || due) report(false);
  }

  async function maybeResume(el) {
    const cur = current;
    cur.resumeAsked = true;
    const r = await send({ type: 'getResume', key: cur.key });
    if (cur !== current) return;
    cur.resumeDone = true;
    if (!r || r.t < MIN_RESUME || r.t > cur.dur - END_GUARD) return;
    if (el.currentTime >= r.t - 5) return; // already there, or the viewer skipped ahead
    const from = el.currentTime;
    el.currentTime = r.t;
    toast(`続き Tsuzuki · Resumed at ${formatTime(r.t)}`, 'Start over', () => {
      el.currentTime = from < MIN_RESUME ? 0 : from;
    });
    // Some players snap back right after a programmatic seek; nudge once more.
    setTimeout(() => {
      if (cur === current && el.currentTime < r.t - 10) el.currentTime = r.t;
    }, 1500);
  }

  function report(ended) {
    if (!current || !current.ready || !current.resumeDone || !(current.dur > 0)) return;
    if (!ended && Math.abs(current.t - current.lastSentT) < 1) return;
    current.lastSentAt = Date.now();
    current.lastSentT = current.t;
    badgeCache.delete(current.key);
    send({
      type: 'progress',
      key: current.key,
      t: ended ? current.dur : current.t,
      dur: current.dur,
      title: adapter.title(),
      ch: adapter.channel(),
      ended,
    });
  }

  /** Record the latest position right now (navigation, tab hidden, page closing). */
  function flush() {
    const el = boundVideo;
    if (current && el && current.ready && !adapter.adShowing() && el.currentSrc === lastTrackedSrc && Number.isFinite(el.duration)) {
      current.t = el.currentTime;
    }
    report(false);
  }

  // ------------------------------------------------------------- thumbnails
  //
  // A marker goes on *every* matching thumbnail, seen or not, and the bar lives
  // in a closed shadow root, so the site's own scripts can't learn your local
  // history from which thumbnails got decorated.

  const marks = new Set(); // { anchor, host, bar, key }
  const markByAnchor = new WeakMap();
  const badgeCache = new Map(); // key -> { info, at }
  let fetching = false;

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

  async function scanThumbnails() {
    const need = new Set();
    const now = Date.now();
    for (const a of document.querySelectorAll(adapter.thumbs)) {
      if (!a.querySelector('img')) continue; // title links etc.
      const key = adapter.identify(a.href);
      if (!key) continue;
      let m = markByAnchor.get(a);
      if (!m || m.host.parentNode !== a) m = mount(a);
      m.key = key; // sites recycle DOM nodes, so re-read the href every pass
      const cached = badgeCache.get(key);
      if (!cached || now - cached.at > BADGE_TTL) need.add(key);
      paint(m);
    }
    for (const m of marks) if (!m.anchor.isConnected) marks.delete(m);

    if (!need.size || fetching) return;
    fetching = true;
    try {
      const keys = [...need].slice(0, 200);
      const result = (await send({ type: 'getMany', keys })) || {};
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

  // ------------------------------------------------------------- start

  onUrlMaybeChanged();
  setInterval(() => {
    onUrlMaybeChanged();
    if (current && !boundVideo?.isConnected) {
      boundVideo = null;
      bindVideo();
    } else if (current && !boundVideo) bindVideo();
  }, 1000);
  for (const ev of adapter.navEvents || []) document.addEventListener(ev, onUrlMaybeChanged);
  window.addEventListener('popstate', onUrlMaybeChanged);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  if (features.badges && adapter.thumbs) startBadges();
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
