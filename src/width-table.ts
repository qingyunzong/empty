/**
 * The given width table. This is the ONLY source of width information:
 * no Unicode libraries, no heuristics outside these ranges.
 *
 * width 2: East Asian Wide / Fullwidth ranges
 * width 0: combining mark ranges
 * everything else: width 1
 */

type Range = readonly [number, number];

export const WIDE_RANGES: readonly Range[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals Supplement .. CJK Symbols and Punctuation
  [0x3041, 0x33ff], // Hiragana .. CJK Compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables / Yi Radicals
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth Signs
  [0x20000, 0x2fffd], // CJK Extension B and beyond
  [0x30000, 0x3fffd], // CJK Extension G and beyond
];

export const COMBINING_RANGES: readonly Range[] = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x0483, 0x0489], // Cyrillic combining signs
  [0x0591, 0x05bd], // Hebrew points
  [0x0610, 0x061a], // Arabic marks
  [0x064b, 0x065f], // Arabic vowel signs
  [0x0e31, 0x0e3a], // Thai marks (subset)
  [0x0eb1, 0x0ebc], // Lao marks (subset)
  [0x20d0, 0x20ff], // Combining Diacritical Marks for Symbols
  [0xfe20, 0xfe2f], // Combining Half Marks
];

function inRanges(cp: number, ranges: readonly Range[]): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

export type CharWidth = 0 | 1 | 2;

export function charWidth(codePoint: number): CharWidth {
  if (inRanges(codePoint, COMBINING_RANGES)) return 0;
  if (inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

export function isCombining(codePoint: number): boolean {
  return charWidth(codePoint) === 0;
}
