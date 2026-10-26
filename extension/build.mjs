// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds the extension for Firefox (incl. Zen) and Safari from one source tree.
//
//   node extension/build.mjs            → dist/firefox and dist/safari
//   node extension/build.mjs safari     → just one target
//   node extension/build.mjs --watch    → rebuild on change (both targets)

import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestContentScripts } from './src/core/services.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const targets = args.filter((a) => !a.startsWith('--'));
const TARGETS = targets.length ? targets : ['firefox', 'safari'];

function manifest(target) {
  const m = {
    manifest_version: 3,
    name: 'Tsuzuki',
    short_name: '続き',
    version: pkg.version,
    description: 'Local-first watch history, resume points and search history. Encrypted, synced only through a relay you own.',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 96: 'icons/96.png', 128: 'icons/128.png', 256: 'icons/256.png', 512: 'icons/512.png' },
    permissions: ['storage', 'alarms'],
    action: {
      default_title: 'Tsuzuki',
      default_popup: 'ui/popup.html',
      default_icon: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png' },
    },
    options_ui: { page: 'ui/options.html', open_in_tab: true },
    commands: {
      'open-home': { suggested_key: { default: 'Alt+Shift+H' }, description: 'Open the Tsuzuki home page' },
    },
    // Generated from extension/src/core/services.js. Scripts on switched-off services exit immediately.
    content_scripts: manifestContentScripts(),
  };

  if (target === 'firefox') {
    m.background = { scripts: ['background.js'] };
    m.permissions.push('unlimitedStorage', 'scripting');
    // User-added instances (Invidious, Piped, PeerTube, SearXNG): access is requested per origin, at runtime.
    m.optional_host_permissions = ['*://*/*'];
    m.incognito = 'not_allowed';
    m.browser_specific_settings = {
      gecko: {
        id: 'tsuzuki@cmapex',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    };
  } else if (target === 'safari') {
    // iOS requires a non-persistent background; a service worker is the MV3 way.
    m.background = { service_worker: 'background.js' };
  } else {
    throw new Error(`unknown target ${target}`);
  }
  return m;
}

const entryPoints = {
  background: join(here, 'src/background/index.js'),
  'content/video': join(here, 'src/content/video.js'),
  'content/search': join(here, 'src/content/search.js'),
  'content/instance': join(here, 'src/content/instance.js'),
  'ui/app': join(here, 'src/ui/app.js'),
  'ui/home': join(here, 'src/ui/home.js'),
  'ui/boot': join(here, 'src/ui/boot.js'),
};

async function buildTarget(target) {
  const out = join(root, 'dist', target);
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'ui'), { recursive: true });

  const options = {
    entryPoints,
    outdir: out,
    bundle: true,
    format: 'iife', // content scripts and Safari's worker can't be ES modules
    target: target === 'safari' ? ['safari16'] : ['firefox140'],
    legalComments: 'none',
    logLevel: 'warning',
    define: { __TARGET__: JSON.stringify(target) },
  };

  await cp(join(here, 'static/icons'), join(out, 'icons'), { recursive: true });
  for (const f of ['popup.html', 'options.html', 'home.html', 'app.css', 'home.css', 'themes.css']) {
    await cp(join(here, 'src/ui', f), join(out, 'ui', f));
  }
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2) + '\n');

  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log(`watching → dist/${target}`);
  } else {
    await build(options);
    console.log(`built → dist/${target}`);
  }
}

for (const t of TARGETS) await buildTarget(t);
