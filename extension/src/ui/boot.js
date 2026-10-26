// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs in <head> before the page paints: apply the last-known theme and custom CSS
// so there's no flash of the default theme. The page re-applies the real settings
// once the background answers.

import { normalizeAppearance } from '../core/theme.js';
import { applyAppearance, cachedAppearance } from './lib.js';

const cached = cachedAppearance();
if (cached) applyAppearance(normalizeAppearance(cached), { cache: false });
