// SPDX-License-Identifier: AGPL-3.0-or-later
// Small DOM + messaging helpers shared by the popup, options page and home page.
// Remembered text always goes in via textContent, never as HTML.

export const api = globalThis.browser ?? globalThis.chrome;

export async function call(type, payload = {}) {
  const res = await api.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('The background script did not answer. Try reopening this page.');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

export function h(tag, props = {}, ...children) {
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

export function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function input(props) {
  return h('input', { autocomplete: 'off', spellcheck: 'false', ...props });
}

export function field(label, el, hint) {
  return h('label', { class: 'field' }, h('span', { text: label }), el, hint && h('small', { text: hint }));
}

/** A destructive button that needs a second tap within 4 seconds. */
export function armedButton(label, confirmLabel, onConfirm) {
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

export function brand() {
  return h('div', { class: 'brand' }, h('span', { class: 'jp', text: '続き' }), h('span', { class: 'dot' }), h('span', { class: 'en', text: 'Tsuzuki' }));
}
