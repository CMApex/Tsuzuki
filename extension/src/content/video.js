// SPDX-License-Identifier: AGPL-3.0-or-later
// Content script for the built-in video sites (YouTube, YouTube Music, Nebula,
// Twitch, Vimeo). Does nothing unless that service is switched on.

import { searchFromUrl, videoServiceForUrl } from '../core/services.js';
import { ADAPTERS } from './adapters.js';
import { startSearchCapture } from './capture.js';
import { isPrivate, rpc } from './rpc.js';
import { startVideoTracker } from './tracker.js';

async function init() {
  const svc = videoServiceForUrl(location.href);
  if (!svc || isPrivate) return;
  const f = await rpc({ type: 'features' });
  if (!f || !f.recording) return;

  if (f.services[svc.id] && ADAPTERS[svc.id]) {
    startVideoTracker({ service: svc.id, adapter: ADAPTERS[svc.id], features: f });
  }
  // YouTube's own search box lives on the same pages.
  if (svc.id === 'youtube' && f.searches && f.services['youtube-search']) {
    startSearchCapture((href) => {
      const r = searchFromUrl(href);
      return r?.service === 'youtube-search' ? r : null;
    }, ADAPTERS.youtube.navEvents);
  }
}

init();
