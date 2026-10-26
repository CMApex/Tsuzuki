// SPDX-License-Identifier: AGPL-3.0-or-later
// Content script for user-added instances (Invidious, Piped, PeerTube, SearXNG).
// Registered at runtime, only on origins the user added and granted access to.

import { INSTANCE_TYPES, instanceSearchFromUrl } from '../core/services.js';
import { instanceAdapter } from './adapters.js';
import { startSearchCapture } from './capture.js';
import { isPrivate, rpc } from './rpc.js';
import { startVideoTracker } from './tracker.js';

async function init() {
  if (isPrivate) return;
  const info = await rpc({ type: 'instance' });
  if (!info || !info.enabled || !info.features.recording) return;
  const type = INSTANCE_TYPES[info.type];
  if (!type) return;
  if (type.video) {
    startVideoTracker({ service: 'instance', adapter: instanceAdapter(info.type), features: info.features });
  }
  if (info.features.searches) startSearchCapture((href) => instanceSearchFromUrl(info.type, href));
}

init();
