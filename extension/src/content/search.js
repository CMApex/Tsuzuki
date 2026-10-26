// SPDX-License-Identifier: AGPL-3.0-or-later
// Search-engine content script: notes the query on results pages.
// Only reads the page URL; never touches the page itself.

import { searchFromUrl } from '../core/parse.js';
import { isPrivate, rpc } from './rpc.js';

let last = '';

function check() {
  const s = searchFromUrl(location.href);
  if (!s) return;
  const sig = `${s.src}\u0000${s.q}`;
  if (sig === last) return;
  last = sig;
  rpc({ type: 'search', q: s.q, src: s.src });
}

if (!isPrivate) {
  check();
  // Some engines change the query in place (pushState) without a full page load.
  setInterval(check, 1500);
  window.addEventListener('popstate', check);
}
