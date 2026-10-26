// SPDX-License-Identifier: AGPL-3.0-or-later
// 続き home page: one place for everything you were in the middle of.
// A search box (any engine, !bangs, live matches from your own history),
// continue-watching across every service, recent searches, recently finished.

import { formatTime } from '../core/parse.js';
import { labelForKey, labelForSrc, linkForKey, parseBang, searchLinkFor, searchTargets } from '../core/services.js';
import { ago, api, brand, call, field, h, input } from './lib.js';

const root = document.getElementById('app');
// Same-tab navigation (this page is meant to be a home / new-tab page). Overridable for tests.
const navigate = (url) => (window.__tsuzukiNavigate ?? ((u) => location.assign(u)))(url);
const OPTIONS_URL = api.runtime.getURL('ui/options.html');

const state = {
  status: null,
  resume: [],
  watched: [],
  searches: [],
  filter: 'all', // key prefix ("yt", "nebula", …) or "all"
  notice: null,
};

// The page is built once; sections are refilled in place so the search box keeps focus and text.
const el = {};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const prefs = () => state.status.cfg.home;
const instances = () => state.status.cfg.instances || [];
const targets = () => searchTargets(state.status.cfg.services, instances());

function defaultEngine() {
  const t = targets();
  return t.find((x) => x.src === prefs().engine)?.src || t[0]?.src || 'duckduckgo';
}

async function loadLists() {
  const [resume, watched, searches] = await Promise.all([
    call('list', { kind: 'resume', limit: 60 }),
    call('list', { kind: 'watched', limit: 40 }),
    call('list', { kind: 'searches', limit: 40 }),
  ]);
  Object.assign(state, { resume, watched, searches });
}

function prefixOf(key) {
  return key.split(':')[0];
}

function thumbUrl(key) {
  if (!prefs().thumbs || prefixOf(key) !== 'yt') return null;
  const id = encodeURIComponent(key.slice(3));
  // Prefer the user's own Invidious, so YouTube's image servers don't see the list.
  const inv = instances().find((i) => i.enabled && i.type === 'invidious');
  return inv ? `${inv.origin}/vi/${id}/mqdefault.jpg` : `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}

// ---------------------------------------------------------------------------
// Search box
// ---------------------------------------------------------------------------

function go(src) {
  const { q, src: bang } = parseBang(el.q.value, instances());
  if (!q) return;
  navigate(searchLinkFor(bang || src || defaultEngine(), q));
}

function renderEngines() {
  const def = defaultEngine();
  el.engines.replaceChildren(
    ...targets().map((t) =>
      h('button', {
        class: 'engine',
        type: 'button',
        'aria-pressed': String(t.src === def),
        title: t.src === def ? 'Default engine' : `Search on ${t.label} (or make it the default when the box is empty)`,
        text: t.label,
        onclick: async () => {
          if (parseBang(el.q.value).q) return go(t.src);
          await call('settings', { home: { engine: t.src } });
          state.status = await call('status');
          renderEngines();
          el.hint.firstChild.textContent = hintText();
          el.q.focus();
        },
      }),
    ),
  );
}

function hintText() {
  const label = targets().find((t) => t.src === defaultEngine())?.label || 'DuckDuckGo';
  return `Enter searches ${label}. Click an engine to search there instead. Bangs work too: `;
}

let matchSeq = 0;
let matchTimer = null;

function scheduleMatches() {
  clearTimeout(matchTimer);
  matchTimer = setTimeout(updateMatches, 120);
}

async function updateMatches() {
  const mine = ++matchSeq;
  const { q } = parseBang(el.q.value, instances());
  if (q.length < 2) {
    el.matches.replaceChildren();
    return;
  }
  const [resume, watched, searches] = await Promise.all(
    ['resume', 'watched', 'searches'].map((kind) => call('list', { kind, query: q, limit: 4 }).catch(() => [])),
  );
  if (mine !== matchSeq) return;
  const items = [
    ...resume.map((e) => ({ kind: 'Continue', text: e.title || labelForKey(e.key), meta: `${formatTime(e.t)} · ${labelForKey(e.key)}`, href: linkForKey(e.key, e.t) })),
    ...watched.map((e) => ({ kind: 'Watched', text: e.title || labelForKey(e.key), meta: labelForKey(e.key), href: linkForKey(e.key) })),
    ...searches.map((e) => ({ kind: 'Searched', text: e.q, meta: labelForSrc(e.src), href: searchLinkFor(e.src, e.q) })),
  ].filter((m) => m.href);
  el.matches.replaceChildren(
    ...items.map((m) =>
      h('li', {}, h('a', { href: m.href }, h('span', { class: 'kind', text: m.kind }), h('span', { class: 't', text: m.text }), h('span', { class: 'm', text: m.meta }))),
    ),
  );
}

function moveSelection(delta) {
  const links = [...el.matches.querySelectorAll('a')];
  if (!links.length) return false;
  const i = links.findIndex((a) => a.getAttribute('aria-selected') === 'true');
  const next = i === -1 ? (delta > 0 ? 0 : links.length - 1) : (i + delta + links.length) % links.length;
  links.forEach((a, n) => a.setAttribute('aria-selected', String(n === next)));
  return true;
}

function searchBox() {
  el.q = input({
    type: 'search',
    placeholder: 'Search the web, or find something you were watching…',
    'aria-label': 'Search',
    enterkeyhint: 'search',
    autofocus: true,
  });
  el.matches = h('ul', { class: 'matches', role: 'listbox', 'aria-label': 'From your history' });
  el.engines = h('div', { class: 'engines', role: 'group', 'aria-label': 'Search engines' });
  el.hint = h(
    'p',
    { class: 'hint' },
    hintText(),
    ...['!yt', '!ddg', '!g', '!yj'].flatMap((b, i) => [i ? ' ' : '', h('kbd', { text: b })]),
  );

  el.q.addEventListener('input', scheduleMatches);
  el.q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (moveSelection(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
    } else if (e.key === 'Escape') {
      el.matches.replaceChildren();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = el.matches.querySelector('a[aria-selected="true"]');
      if (picked) navigate(picked.href);
      else go();
    }
  });
  const form = h(
    'form',
    { class: 'qbox', role: 'search', onsubmit: (e) => (e.preventDefault(), go()) },
    el.q,
    h('button', { class: 'go', type: 'submit', text: 'Search' }),
  );
  renderEngines();
  return h(
    'section',
    { class: 'home-search' },
    h('div', { class: 'jp-mark', text: '続き' }),
    h('div', { class: 'qwrap' }, form, el.matches),
    el.engines,
    el.hint,
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

async function forgetItem(kind, key) {
  try {
    await call('forget', { kind, key });
    await loadLists();
    fillSections();
  } catch (e) {
    showNotice('err', e.message);
  }
}

function forgetButton(kind, key) {
  return h('button', {
    class: 'x',
    type: 'button',
    title: 'Forget',
    'aria-label': 'Forget',
    text: '×',
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      forgetItem(kind, key);
    },
  });
}

function videoCard(e) {
  const href = linkForKey(e.key, e.t);
  const img = thumbUrl(e.key);
  const left = Math.max(0, e.dur - e.t);
  const pct = Math.min(100, Math.round((e.t / e.dur) * 100));
  return h(
    href ? 'a' : 'div',
    { class: 'card-v', href },
    h(
      'div',
      { class: 'thumb' },
      img ? h('img', { src: img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'svc', text: labelForKey(e.key) }),
      h('span', { class: 'left', text: `${formatTime(left)} left` }),
      h('div', { class: 'prog' }, h('i', { style: `width:${pct}%` })),
    ),
    h(
      'div',
      { class: 'body' },
      h('div', { class: 'ttl', text: e.title || `${labelForKey(e.key)} video` }),
      h('div', { class: 'sub', text: [e.ch, labelForKey(e.key), ago(e.at)].filter(Boolean).join(' · ') }),
    ),
    forgetButton('resume', e.key),
  );
}

function filterChips() {
  const prefixes = [...new Set([...state.resume, ...state.watched].map((e) => prefixOf(e.key)))];
  if (prefixes.length < 2) return null;
  const label = (p) => (p === 'pt' ? 'PeerTube' : labelForKey(`${p}:x`));
  const chip = (value, text) =>
    h('button', {
      class: 'engine',
      type: 'button',
      'aria-pressed': String(state.filter === value),
      text,
      onclick: () => {
        state.filter = value;
        fillSections();
      },
    });
  return h('div', { class: 'filters' }, chip('all', 'All'), prefixes.map((p) => chip(p, label(p))));
}

function againSelect(e) {
  const others = targets().filter((t) => t.src !== e.src);
  if (!others.length) return null;
  return h(
    'select',
    {
      class: 'again',
      'aria-label': `Search again for "${e.q}" on…`,
      onchange: (ev) => {
        const src = ev.target.value;
        ev.target.value = '';
        if (src) navigate(searchLinkFor(src, e.q));
      },
    },
    h('option', { value: '', text: 'Again on…' }),
    others.map((t) => h('option', { value: t.src, text: t.label })),
  );
}

function section(title, count, body, extra = null) {
  return h(
    'section',
    { class: 'sec' },
    h('div', { class: 'sec-head' }, h('h2', { text: title }), count != null ? h('span', { class: 'n', text: String(count) }) : null, extra),
    body,
  );
}

function fillSections() {
  const keep = (e) => state.filter === 'all' || prefixOf(e.key) === state.filter;
  const resume = state.resume.filter(keep);
  const watched = state.watched.filter(keep).slice(0, 24);
  const parts = [];

  parts.push(
    section(
      'Continue watching',
      resume.length,
      resume.length
        ? h('div', { class: 'grid' }, resume.map(videoCard))
        : h('p', { class: 'muted', text: 'Nothing in progress. Stop a video partway through and it will wait for you here.' }),
      filterChips(),
    ),
  );

  if (state.searches.length) {
    parts.push(
      section(
        'Recent searches',
        null,
        h(
          'ul',
          { class: 'searches' },
          state.searches.slice(0, 24).map((e) =>
            h(
              'li',
              {},
              h('a', { href: searchLinkFor(e.src, e.q), text: e.q, title: `${labelForSrc(e.src)} · ${ago(e.at)}` }),
              h('span', { class: 'src', text: labelForSrc(e.src) }),
              againSelect(e),
            ),
          ),
        ),
      ),
    );
  }

  if (watched.length) {
    parts.push(
      section(
        'Recently finished',
        null,
        h(
          'ul',
          { class: 'done' },
          watched.map((e) => {
            const href = linkForKey(e.key);
            const t = e.title || `${labelForKey(e.key)} video`;
            return h('li', {}, href ? h('a', { href, text: t }) : h('span', { text: t }), h('span', { class: 'src', text: `${labelForKey(e.key)} · ${ago(e.at)}` }));
          }),
        ),
      ),
    );
  }
  el.sections.replaceChildren(...parts);
}

function footer() {
  const thumbs = h('input', {
    type: 'checkbox',
    checked: prefs().thumbs,
    onchange: async (e) => {
      await call('settings', { home: { thumbs: e.target.checked } });
      state.status = await call('status');
      fillSections();
    },
  });
  const hasInv = instances().some((i) => i.enabled && i.type === 'invidious');
  return h(
    'footer',
    { class: 'home-foot' },
    h(
      'label',
      { title: hasInv ? 'Loaded through your Invidious instance.' : "Loads images from YouTube's servers, which tells YouTube which videos are on this page." },
      thumbs,
      hasInv ? 'YouTube thumbnails (via your Invidious)' : 'YouTube thumbnails (loads from YouTube)',
    ),
    h('span', {}, 'Open this page with ', h('kbd', { text: 'Alt+Shift+H' })),
    h('a', { href: OPTIONS_URL, text: 'Settings' }),
  );
}

// ---------------------------------------------------------------------------
// Page states
// ---------------------------------------------------------------------------

function header(extra = []) {
  const s = state.status;
  const right = [];
  if (s?.cfg?.relayUrl) {
    const err = s.sync?.lastError;
    right.push(
      h(
        'span',
        { class: 'icon-btn', title: err || '' },
        h('span', { class: `led ${err ? 'err' : s.sync?.lastSyncAt ? 'ok' : ''}` }),
        err ? 'Sync error' : s.sync?.lastSyncAt ? `Synced ${ago(s.sync.lastSyncAt)}` : 'Not synced',
      ),
    );
  }
  return h('header', { class: 'top' }, brand(), ...right, ...extra);
}

function showNotice(kind, text) {
  state.notice = { kind, text };
  const n = h('div', { class: `notice ${kind}`, role: kind === 'err' ? 'alert' : 'status', text });
  root.querySelector('.notice')?.remove();
  root.insertBefore(n, root.children[1] || null);
}

function gate(title, body) {
  root.replaceChildren(header(), h('div', { class: 'home-gate card' }, h('h2', { text: title }), ...body));
  root.querySelector('[autofocus]')?.focus();
}

function lockedView() {
  const pass = input({ type: 'password', autocomplete: 'current-password', autofocus: true });
  const btn = h('button', { class: 'btn primary block', type: 'submit', text: 'Unlock' });
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        btn.textContent = 'Unlocking…';
        try {
          await call('unlock', { passphrase: pass.value });
          await start();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Unlock';
          showNotice('err', err.message);
        }
      },
    },
    field('Passphrase', pass),
    btn,
  );
  gate('Locked', [h('p', { text: `${state.status.cfg.deviceName} · your history is encrypted until you unlock it.` }), form]);
}

async function mainView() {
  await loadLists();
  const lock = h('button', {
    class: 'icon-btn',
    type: 'button',
    text: 'Lock',
    onclick: async () => {
      await call('lock');
      await start();
    },
  });
  el.sections = h('div', { class: 'sections' });
  root.replaceChildren(header([h('a', { class: 'icon-btn', href: OPTIONS_URL, text: 'Settings' }), lock]), searchBox(), el.sections, footer());
  fillSections();
  el.q.focus();
}

async function start() {
  try {
    state.status = await call('status');
  } catch (e) {
    root.replaceChildren(header(), h('div', { class: 'notice err', text: e.message }));
    return;
  }
  const s = state.status;
  if (!s.configured) {
    return gate('Set up Tsuzuki', [
      h('p', { text: 'Create a vault (or join one from another device) and this page fills with everything you were in the middle of.' }),
      h('a', { class: 'btn primary block', href: OPTIONS_URL, text: 'Open setup', style: 'display:block;text-align:center;text-decoration:none' }),
    ]);
  }
  if (!s.unlocked) return lockedView();
  return mainView();
}

// Refresh when the tab comes back into view (handy as a new-tab / home page).
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.status?.unlocked || !el.sections?.isConnected) return;
  try {
    state.status = await call('status');
    await loadLists();
    fillSections();
  } catch {}
});

start();
