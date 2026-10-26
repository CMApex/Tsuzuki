// SPDX-License-Identifier: AGPL-3.0-or-later
// Tsuzuki popup + options page. Plain DOM, no framework; every piece of
// remembered text is inserted with textContent, never as HTML.

import { formatTime, searchLink, youtubeLink } from '../core/parse.js';

const api = globalThis.browser ?? globalThis.chrome;
const isPopup = document.body.dataset.mode === 'popup';
const root = document.getElementById('app');
const VERSION = api.runtime.getManifest().version;
const MIN_PASSPHRASE = 12;

const ui = {
  status: null,
  tab: 'resume',
  query: '',
  setupMode: 'create',
  notice: null, // { kind: 'ok'|'err', text }
  createdVault: null,
  busy: false,
};

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function call(type, payload = {}) {
  const res = await api.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('The background script did not answer. Try reopening this page.');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function open(url) {
  api.tabs.create({ url });
  if (isPopup) window.close();
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os && `on ${os}`].filter(Boolean).join(' ');
}

function notice() {
  if (!ui.notice) return null;
  return h('div', { class: `notice ${ui.notice.kind}`, role: ui.notice.kind === 'err' ? 'alert' : 'status', text: ui.notice.text });
}

function say(kind, text) {
  ui.notice = { kind, text };
  render();
}

/** Run an action with a busy button and error reporting. */
async function act(button, fn, busyLabel) {
  if (ui.busy) return;
  ui.busy = true;
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
  }
  try {
    await fn();
  } catch (e) {
    ui.notice = { kind: 'err', text: e.message };
  } finally {
    ui.busy = false;
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
    await refresh();
  }
}

/** A destructive button that needs a second tap within 4 seconds. */
function armedButton(label, confirmLabel, onConfirm) {
  const btn = h('button', { class: 'btn danger', type: 'button', text: label });
  let timer = null;
  btn.addEventListener('click', () => {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = confirmLabel;
      timer = setTimeout(() => {
        btn.classList.remove('armed');
        btn.textContent = label;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    onConfirm(btn);
  });
  return btn;
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { text: label }), input, hint && h('small', { text: hint }));
}

function input(props) {
  return h('input', { autocomplete: 'off', spellcheck: 'false', ...props });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function header(right = []) {
  return h(
    'header',
    { class: 'top' },
    h('div', { class: 'brand' }, h('span', { class: 'jp', text: '続き' }), h('span', { class: 'dot' }), h('span', { class: 'en', text: 'Tsuzuki' })),
    ...right,
  );
}

function setupView() {
  const mode = ui.setupMode;
  const segBtn = (m, text) =>
    h('button', {
      type: 'button',
      'aria-pressed': String(mode === m),
      text,
      onclick: () => {
        ui.setupMode = m;
        ui.notice = null;
        render();
      },
    });

  const pass = input({ type: 'password', autocomplete: 'new-password', minlength: MIN_PASSPHRASE, required: true });
  const pass2 = input({ type: 'password', autocomplete: 'new-password' });
  const vaultCode = input({ placeholder: 'e.g. 3vQ9…', required: true });
  const name = input({ value: guessDeviceName(), maxlength: 60 });
  const relay = input({ type: 'url', placeholder: 'https://relay.example.net', inputmode: 'url' });
  const reg = input({ type: 'password' });

  const submit = h('button', { class: 'btn primary block', type: 'submit', text: mode === 'create' ? 'Create vault' : 'Join vault' });

  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        ui.notice = null;
        if (mode === 'create') {
          if (pass.value.length < MIN_PASSPHRASE) return say('err', `Use at least ${MIN_PASSPHRASE} characters. Four or five random words is ideal.`);
          if (pass.value !== pass2.value) return say('err', "The passphrases don't match.");
          act(submit, async () => {
            const res = await call('create', { passphrase: pass.value, deviceName: name.value, relayUrl: relay.value, registerToken: reg.value });
            ui.createdVault = res.vaultId;
            ui.notice = res.syncError
              ? { kind: 'err', text: `Vault created, but the relay said: ${res.syncError}. You can fix this in Settings.` }
              : null;
          }, 'Deriving key…');
        } else {
          act(submit, async () => {
            const res = await call('join', {
              vaultId: vaultCode.value, passphrase: pass.value, deviceName: name.value, relayUrl: relay.value, registerToken: reg.value,
            });
            ui.notice = { kind: 'ok', text: `Joined. Pulled ${res.stats.resume} resume points, ${res.stats.watched} watched, ${res.stats.searches} searches.` };
          }, 'Joining…');
        }
      },
    },
    mode === 'join' && field('Vault code', vaultCode, 'Shown in Settings on the device that created the vault.'),
    field('Passphrase', pass, mode === 'create' ? 'Encrypts everything. There is no recovery if you forget it.' : null),
    mode === 'create' && field('Confirm passphrase', pass2),
    field('Device name', name),
    field(mode === 'create' ? 'Sync relay (optional)' : 'Sync relay', relay, mode === 'create' ? 'Leave empty to stay on this device only. You can add one later.' : null),
    h('details', {}, h('summary', { text: 'Advanced' }), field('Relay registration token', reg, 'Only if your relay was started with TSUZUKI_REGISTER_TOKEN.')),
    submit,
  );

  return [
    header(),
    h(
      'section',
      { class: 'hero' },
      h('div', { class: 'jp', text: '続き' }),
      h('p', { text: 'Remembers where you stopped, what you watched and what you searched. It all stays on your devices, encrypted.' }),
    ),
    h('div', { class: 'seg', role: 'group' }, segBtn('create', 'New vault'), segBtn('join', 'Join a vault')),
    notice(),
    form,
  ];
}

function createdView() {
  const code = ui.createdVault;
  return [
    header(),
    notice(),
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Vault ready' }),
      h('p', { text: 'To add another device, you will need this vault code plus your passphrase. The code is not secret, but keep it handy.' }),
      h('div', { class: 'row' }, h('div', { class: 'code', text: code }), copyButton(code)),
    ),
    h('button', {
      class: 'btn primary block',
      type: 'button',
      text: 'Start remembering',
      onclick: () => {
        ui.createdVault = null;
        ui.notice = null;
        render();
      },
    }),
  ];
}

function lockedView() {
  const s = ui.status;
  const pass = input({ type: 'password', autocomplete: 'current-password', autofocus: true });
  const submit = h('button', { class: 'btn primary block', type: 'submit', text: 'Unlock' });
  return [
    header(),
    h('section', { class: 'hero' }, h('div', { class: 'jp', text: '続き' }), h('p', { text: `${s.cfg.deviceName} · locked` })),
    notice(),
    h(
      'form',
      {
        class: 'card',
        onsubmit: (e) => {
          e.preventDefault();
          ui.notice = null;
          act(submit, () => call('unlock', { passphrase: pass.value }), 'Unlocking…');
        },
      },
      field('Passphrase', pass),
      s.pending ? h('p', { class: 'muted', text: `${s.pending} event${s.pending === 1 ? '' : 's'} captured while locked will be saved when you unlock.` }) : null,
      submit,
    ),
    h(
      'details',
      { class: 'card' },
      h('summary', { text: 'Forgot the passphrase?' }),
      h('p', { text: 'The ledger on this device cannot be recovered without it. You can wipe this device and start over or join from another device.' }),
      armedButton('Wipe this device', 'Tap again to wipe', (b) => act(b, () => call('wipe'))),
    ),
  ];
}

function syncIndicator() {
  const s = ui.status;
  if (!s.cfg.relayUrl) return null;
  const err = s.sync?.lastError;
  const label = err ? 'Sync error' : s.sync?.lastSyncAt ? `Synced ${ago(s.sync.lastSyncAt)}` : 'Not synced';
  const btn = h(
    'button',
    { class: 'icon-btn', type: 'button', title: err || 'Sync now' },
    h('span', { class: `led ${err ? 'err' : s.sync?.lastSyncAt ? 'ok' : ''}` }),
    label,
  );
  btn.addEventListener('click', () => {
    btn.setAttribute('aria-busy', 'true');
    act(null, async () => {
      const r = await call('syncNow');
      ui.notice = r.errors?.length
        ? { kind: 'err', text: `Synced, but ${r.errors.length} device snapshot(s) couldn't be decrypted.` }
        : { kind: 'ok', text: r.merged ? `Pulled ${r.merged} change${r.merged === 1 ? '' : 's'} from other devices.` : 'Up to date.' };
    });
  });
  return btn;
}

function mainView() {
  const s = ui.status;
  const lockBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Lock', text: 'Lock', onclick: () => act(null, () => call('lock')) });
  const tabs = [
    ['resume', 'Continue', s.stats.resume],
    ['watched', 'Watched', s.stats.watched],
    ['searches', 'Searches', s.stats.searches],
    ['settings', 'Settings', null],
  ];
  const tabBar = h(
    'nav',
    { class: 'tabs', role: 'tablist' },
    tabs.map(([id, label, n]) =>
      h(
        'button',
        {
          class: 'tab',
          role: 'tab',
          type: 'button',
          'aria-selected': String(ui.tab === id),
          onclick: () => {
            ui.tab = id;
            ui.notice = null;
            render();
          },
        },
        label,
        n !== null ? h('span', { class: 'n', text: n }) : null,
      ),
    ),
  );

  const body = h('section', { id: 'panel' });
  if (ui.tab === 'settings') body.append(...settingsView());
  else renderList(body);

  return [header([syncIndicator(), lockBtn]), tabBar, notice(), body, h('footer', { text: `Tsuzuki ${VERSION} · nothing leaves this device unencrypted` })];
}

async function renderList(container) {
  const kind = ui.tab;
  const filter = input({
    class: 'filter',
    type: 'search',
    placeholder: kind === 'searches' ? 'Filter searches' : 'Filter by title or channel',
    value: ui.query,
  });
  const list = h('ul', { class: 'list' });
  container.append(filter, list);

  let seq = 0;
  async function fill() {
    const mine = ++seq;
    let entries;
    try {
      entries = await call('list', { kind, query: ui.query, limit: 300 });
    } catch (e) {
      list.replaceChildren(h('li', { class: 'notice err', text: e.message }));
      return;
    }
    if (mine !== seq) return;
    list.replaceChildren(...(entries.length ? entries.map((e) => row(kind, e)) : [emptyState(kind)]));
  }
  filter.addEventListener('input', () => {
    ui.query = filter.value;
    fill();
  });
  fill();
  if (!isPopup || ui.query) queueMicrotask(() => filter.focus());
}

function emptyState(kind) {
  const text = ui.query
    ? 'Nothing matches that filter.'
    : {
        resume: 'Start a video and stop partway through. It will wait for you here.',
        watched: 'Videos you finish show up here.',
        searches: 'Searches on Google, DuckDuckGo, Bing, Brave, Kagi and YouTube show up here.',
      }[kind];
  return h('li', { class: 'empty' }, h('span', { class: 'glyph', text: '〇' }), text);
}

function row(kind, e) {
  const forgetBtn = h('button', {
    class: 'x',
    type: 'button',
    title: 'Forget',
    'aria-label': 'Forget',
    text: '×',
    onclick: async (ev) => {
      ev.stopPropagation();
      try {
        await call('forget', { kind, key: e.key });
        li.remove();
        ui.status = await call('status');
        const n = document.querySelector('.tab[aria-selected="true"] .n');
        if (n) n.textContent = ui.status.stats[kind];
      } catch (err) {
        say('err', err.message);
      }
    },
  });

  let title, meta, link, bar = null;
  if (kind === 'searches') {
    title = e.q;
    meta = `${e.src} · ${ago(e.at)}`;
    link = searchLink(e.q, e.src);
  } else {
    title = e.title || e.key.replace(/^yt:/, 'YouTube video ');
    const where = kind === 'resume' ? `${formatTime(e.t)} of ${formatTime(e.dur)}` : 'finished';
    meta = [e.ch, where, ago(e.at)].filter(Boolean).join(' · ');
    link = youtubeLink(e.key, kind === 'resume' ? e.t : 0);
    if (kind === 'resume') {
      bar = h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, Math.round((e.t / e.dur) * 100))}%` }));
    }
  }

  const a = h('a', {
    class: 'title',
    href: link,
    text: title,
    onclick: (ev) => {
      ev.preventDefault();
      open(link);
    },
  });
  const li = h('li', { class: 'item' }, a, forgetBtn, h('div', { class: 'meta', text: meta }), bar);
  return li;
}

function copyButton(text) {
  return h('button', {
    class: 'btn',
    type: 'button',
    text: 'Copy',
    onclick: async (e) => {
      try {
        await navigator.clipboard.writeText(text);
        e.target.textContent = 'Copied';
      } catch {
        e.target.textContent = 'Select & copy manually';
      }
    },
  });
}

function settingsView() {
  const s = ui.status;
  const f = s.cfg.features;

  const toggle = (key, label, hint) =>
    h(
      'label',
      { class: 'toggle' },
      h('input', {
        type: 'checkbox',
        checked: f[key],
        onchange: (e) =>
          act(null, async () => {
            await call('settings', { features: { [key]: e.target.checked } });
            ui.notice = { kind: 'ok', text: 'Saved. Reload open YouTube tabs to apply.' };
          }),
      }),
      h('span', {}, h('b', { text: label }), h('small', { text: hint })),
    );

  const relay = input({ type: 'url', value: s.cfg.relayUrl, placeholder: 'https://relay.example.net' });
  const reg = input({ type: 'password', placeholder: s.cfg.hasRegisterToken ? '•••••• (saved)' : '' });
  const name = input({ value: s.cfg.deviceName, maxlength: 60 });
  const saveSync = h('button', { class: 'btn', type: 'submit', text: 'Save' });

  const sync = s.sync || {};
  const syncLine = !s.cfg.relayUrl
    ? 'Sync is off. Everything stays on this device.'
    : sync.lastError
      ? `Last error: ${sync.lastError}`
      : sync.lastSyncAt
        ? `Last synced ${ago(sync.lastSyncAt)} · ${sync.devices} other device${sync.devices === 1 ? '' : 's'} seen`
        : 'Not synced yet.';

  const importInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: 'display:none',
    onchange: (e) => {
      const file = e.target.files[0];
      if (!file) return;
      act(null, async () => {
        const data = JSON.parse(await file.text());
        const r = await call('import', { data });
        ui.notice = { kind: 'ok', text: `Imported ${r.merged} record${r.merged === 1 ? '' : 's'}.` };
      });
    },
  });

  const alsoRelay = h('input', { type: 'checkbox', checked: !!s.cfg.relayUrl });

  return [
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Recording' }),
      toggle('recording', 'Remember things', 'Master switch. Off means nothing new is recorded anywhere.'),
      toggle('resume', 'Resume where I stopped', 'Jumps back to your last position when you reopen a video.'),
      toggle('badges', 'Progress bars on thumbnails', 'Drawn privately inside the page; YouTube cannot read them.'),
      toggle('searches', 'Search history', 'Google, DuckDuckGo, Bing, Brave, Kagi and YouTube searches.'),
    ),
    h(
      'form',
      {
        class: 'card',
        onsubmit: (e) => {
          e.preventDefault();
          act(saveSync, async () => {
            const payload = { relayUrl: relay.value, deviceName: name.value };
            if (reg.value) payload.registerToken = reg.value;
            await call('settings', payload);
            ui.notice = { kind: 'ok', text: 'Saved.' };
            if (relay.value) {
              try {
                await call('syncNow');
              } catch (err) {
                ui.notice = { kind: 'err', text: err.message };
              }
            }
          });
        },
      },
      h('h2', { text: 'Sync' }),
      field('Relay URL', relay, 'Your own tsuzuki-relay. It only ever sees ciphertext.'),
      field('Registration token', reg, 'Only needed if the relay requires one to create vaults.'),
      field('This device is called', name),
      h('p', { class: 'muted', text: syncLine }),
      h('div', { class: 'row' }, saveSync),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Add another device' }),
      h('p', { text: 'On the other device choose "Join a vault" and enter this code, your passphrase and the same relay URL.' }),
      h('div', { class: 'row' }, h('div', { class: 'code', text: s.cfg.vaultId }), copyButton(s.cfg.vaultId)),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Your data' }),
      h('p', { text: 'Exports are plain JSON (not encrypted). Imports merge; they never overwrite newer data.' }),
      h(
        'div',
        { class: 'row' },
        h('button', {
          class: 'btn',
          type: 'button',
          text: 'Export JSON',
          onclick: () =>
            act(null, async () => {
              const data = await call('export');
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = h('a', { href: url, download: `tsuzuki-${new Date().toISOString().slice(0, 10)}.json` });
              document.body.append(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 10_000);
            }),
        }),
        h('button', { class: 'btn', type: 'button', text: 'Import JSON', onclick: () => importInput.click() }),
        importInput,
      ),
      h('hr', { style: 'border:0;border-top:1px solid var(--rule);margin:14px 0' }),
      h('label', { class: 'toggle' }, alsoRelay, h('span', {}, h('b', { text: "Also remove this device's copy from the relay" }), h('small', { text: 'Other devices keep their own copies.' }))),
      armedButton('Wipe this device', 'Tap again to wipe', (b) =>
        act(b, async () => {
          const r = await call('wipe', { alsoRelay: alsoRelay.checked });
          ui.notice = r.relayError ? { kind: 'err', text: `Wiped locally, but the relay said: ${r.relayError}` } : { kind: 'ok', text: 'Wiped.' };
        }),
      ),
    ),
  ];
}

// ---------------------------------------------------------------------------

function render() {
  const s = ui.status;
  let view;
  if (!s) view = [header(), h('p', { class: 'muted', text: 'Loading…' })];
  else if (ui.createdVault) view = createdView();
  else if (!s.configured) view = setupView();
  else if (!s.unlocked) view = lockedView();
  else view = mainView();
  root.replaceChildren(...view.filter(Boolean));
  root.querySelector('[autofocus]')?.focus();
}

async function refresh() {
  try {
    ui.status = await call('status');
  } catch (e) {
    ui.status = null;
    ui.notice = { kind: 'err', text: e.message };
  }
  render();
}

refresh();
