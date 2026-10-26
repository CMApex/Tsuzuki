// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-site knowledge for the video tracker: where the player is, whether an ad
// is playing, and where the title lives. Everything not overridden falls back to
// generic behaviour (largest <video>, og:title / document.title).
//
// These selectors are the part most likely to break when a site redesigns.

import { INSTANCE_TYPES, identifyVideo, serviceById } from '../core/services.js';

function text(sel) {
  const el = document.querySelector(sel);
  return el ? el.textContent.trim().replace(/\s+/g, ' ') : '';
}

function largestVideo() {
  let best = null;
  let bestArea = -1;
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Best title from og:title, then document.title, with the site's suffix removed.
 * A bare site name ("Twitch") is never accepted: single-page apps often leave
 * og:title at their default, while document.title tracks the actual video.
 */
function cleanTitle(suffix, siteName = '') {
  const candidates = [document.querySelector('meta[property="og:title"]')?.content, document.title];
  for (const raw of candidates) {
    let t = String(raw || '').replace(/^\(\d+\)\s*/, '').trim();
    if (suffix) t = t.replace(suffix, '').trim();
    if (t && t.toLowerCase() !== siteName.toLowerCase()) return t;
  }
  return '';
}

function make(id, overrides) {
  const def = serviceById(id) || INSTANCE_TYPES[id];
  return {
    identify: (url) => identifyVideo(id, url),
    findVideo: largestVideo,
    adShowing: () => false,
    title: () => cleanTitle(undefined, def?.label || ''),
    channel: () => '',
    thumbs: def?.thumbs || null,
    navEvents: def?.navEvents || [],
    ...overrides,
  };
}

const youtubeAds = () => !!document.querySelector('.ad-showing, .ad-interrupting');

export const ADAPTERS = {
  youtube: make('youtube', {
    findVideo: () =>
      document.querySelector('#movie_player video') ||
      document.querySelector('#player-container-id video') ||
      document.querySelector('video.html5-main-video') ||
      largestVideo(),
    adShowing: youtubeAds,
    // document.title lags behind SPA navigation, so prefer the on-page heading.
    title: () =>
      text('ytd-watch-metadata h1') ||
      text('h1.ytd-watch-metadata') ||
      text('.slim-video-information-title') ||
      text('.slim-video-metadata-header h2') ||
      document.title.replace(/^\(\d+\)\s*/, '').replace(/\s+-\s+YouTube$/, ''),
    channel: () =>
      text('ytd-watch-metadata ytd-channel-name a') ||
      text('#owner ytd-channel-name a') ||
      text('.slim-owner-channel-name') ||
      text('ytm-slim-owner-renderer .YtmBadgeAndBylineRendererItemByline'),
  }),

  'youtube-music': make('youtube-music', {
    adShowing: youtubeAds,
    title: () => text('ytmusic-player-bar .title') || cleanTitle(/\s+-\s+YouTube Music$/, 'YouTube Music'),
    channel: () => text('ytmusic-player-bar .byline a') || text('ytmusic-player-bar .byline'),
  }),

  nebula: make('nebula', {
    title: () => cleanTitle(/\s+[–|-]\s+Nebula$/, 'Nebula'),
  }),

  twitch: make('twitch', {
    adShowing: () =>
      !!document.querySelector('[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], .video-ad-label'),
    // Twitch keeps og:title at "Twitch"; document.title is "<video title> - Twitch" (verified on a live VOD page).
    title: () => text('[data-a-target="stream-title"]') || cleanTitle(/\s+-\s+Twitch$/, 'Twitch'),
    channel: () => text('[data-a-target="video-info-channel-link"]') || text('h1.tw-title') || text('main h1') || text('h1'),
  }),

  vimeo: make('vimeo', {
    title: () => cleanTitle(/\s+(on|from .+ on)\s+Vimeo$/, 'Vimeo'),
  }),
};

/** Adapter for a user-added instance (Invidious, Piped, PeerTube). */
export function instanceAdapter(type) {
  const suffix = { invidious: /\s+-\s+Invidious$/, piped: /\s+-\s+Piped$/ }[type];
  return make(type, {
    title: () => cleanTitle(suffix, INSTANCE_TYPES[type]?.label || ''),
    channel: () => (type === 'invidious' ? text('#channel-name') : ''),
  });
}
