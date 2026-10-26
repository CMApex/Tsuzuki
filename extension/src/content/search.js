// SPDX-License-Identifier: AGPL-3.0-or-later
// Content script for the built-in search engines. Does nothing unless that
// engine is switched on.

import { searchFromUrl, servicesForUrl, SEARCH } from '../core/services.js';
import { startSearchCapture } from './capture.js';
import { isPrivate, rpc } from './rpc.js';

async function init() {
  const engine = servicesForUrl(location.href).find((s) => s.kind === SEARCH);
  if (!engine || isPrivate) return;
  const f = await rpc({ type: 'features' });
  if (!f || !f.recording || !f.searches || !f.services[engine.id]) return;
  startSearchCapture((href) => {
    const r = searchFromUrl(href);
    return r?.service === engine.id ? r : null;
  });
}

init();
