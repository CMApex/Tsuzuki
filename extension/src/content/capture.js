// SPDX-License-Identifier: AGPL-3.0-or-later
// Search capture. Reads the query from the URL, or (for engines that POST it)
// from the results page's own search box. Never modifies the page.

import { rpc } from './rpc.js';

/**
 * @param {(href: string) => ({q, src} | {needsInput, src} | null)} detect
 * @param {string[]} [navEvents] extra events that signal an in-page navigation
 */
export function startSearchCapture(detect, navEvents = []) {
  let last = '';

  function check() {
    const r = detect(location.href);
    if (!r) return;
    let q = r.q;
    if (!q && r.needsInput) q = document.querySelector(r.needsInput)?.value?.trim();
    if (!q) return;
    const sig = `${r.src}\u0000${q}`;
    if (sig === last) return;
    last = sig;
    rpc({ type: 'search', q, src: r.src });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check, { once: true });
  else check();
  setInterval(check, 1500); // some engines change the query in place (pushState)
  window.addEventListener('popstate', check);
  for (const ev of navEvents) document.addEventListener(ev, check);
}
