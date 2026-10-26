// SPDX-License-Identifier: AGPL-3.0-or-later
// Fuzzy matching for searching your own history. Pure functions, no dependencies.
//
// A query matches a record when *every* query word matches somewhere, in any order.
// Each word can match, best first:
//   1. as a substring of the text           ("tsugi"  → "Kintsugi")       score 1.0, or 0.9 mid-word
//   2. with a typo (one or two edits)        ("kintusgi" → "Kintsugi")     score 0.75 / 0.6
//   3. as letters in order within one word   ("kntsg"  → "Kintsugi")       score 0.45
// Text is normalised first: case, width (ｶﾀｶﾅ → カタカナ), accents (café → cafe) and
// katakana/hiragana (カタカナ ↔ かたかな) don't matter.

/** Fold text for comparison. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '') // accents and other combining marks
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)) // katakana → hiragana
    .normalize('NFC');
}

/** Split normalised text into words (letters and digits; punctuation separates). */
export function words(normalized) {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function maxEdits(len) {
  if (len <= 3) return 0;
  if (len <= 7) return 1;
  return 2;
}

/**
 * Optimal-string-alignment distance (Levenshtein + adjacent transposition),
 * giving up early once it must exceed `max`. Returns max + 1 when over.
 */
export function editDistance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  let prev2 = null;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

function isSubsequence(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

/** Best score (0 = no match) for one query word against a text and its words. */
function scoreWord(token, text, textWords) {
  const at = text.indexOf(token);
  if (at !== -1) {
    const startsWord = at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]);
    return startsWord ? 1 : 0.9;
  }
  const max = maxEdits(token.length);
  let best = 0;
  if (max > 0) {
    for (const w of textWords) {
      // Compare with the whole word, and with its start (you may still be typing).
      const d = Math.min(editDistance(token, w, max), w.length > token.length ? editDistance(token, w.slice(0, token.length), max) : Infinity);
      if (d <= max) best = Math.max(best, d === 1 ? 0.75 : 0.6);
      if (best === 0.75) return best;
    }
  }
  if (best) return best;
  if (token.length >= 3) {
    for (const w of textWords) {
      if (w[0] === token[0] && w.length > token.length && isSubsequence(token, w)) return 0.45;
    }
  }
  return 0;
}

/** Prepare a query once, then test many records with matchScore(). */
export function compileQuery(query) {
  const tokens = words(normalize(query));
  return { tokens, empty: tokens.length === 0 };
}

/** Normalise text once so it can be scored against many queries. */
export function prepareText(text) {
  const norm = normalize(text);
  return { norm, words: words(norm) };
}

/** Score text (a string or prepareText() result) against a compiled query: 0 (no match) … 1 (all words exact). */
export function matchScore(compiled, text) {
  if (compiled.empty) return 1;
  const { norm, words: ws } = typeof text === 'string' ? prepareText(text) : text;
  let sum = 0;
  for (const t of compiled.tokens) {
    const s = scoreWord(t, norm, ws);
    if (!s) return 0;
    sum += s;
  }
  return sum / compiled.tokens.length;
}
