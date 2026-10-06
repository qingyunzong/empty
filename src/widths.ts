/**
 * 给定宽度表：字符宽度只能由本表决定，不依赖任何平台/第三方数据。
 *
 * ZERO_WIDTH_RANGES：组合标记（结合符），宽度 0，附加到前一基字符。
 * WIDE_RANGES：东亚宽字符 / 全角字符，宽度 2，占两格。
 * 其余可打印字符宽度为 1。
 */

type Range = readonly [number, number];

const ZERO_WIDTH_RANGES: readonly Range[] = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x0483, 0x0489], // Cyrillic combining
  [0x0591, 0x05bd], // Hebrew points
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x0610, 0x061a], // Arabic
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0e31, 0x0e31], // Thai
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
  [0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
  [0x20d0, 0x20ff], // Combining Diacritical Marks for Symbols
  [0xfe00, 0xfe0f], // Variation Selectors
  [0xfe20, 0xfe2f], // Combining Half Marks
  [0xe0100, 0xe01ef], // Variation Selectors Supplement
];

const WIDE_RANGES: readonly Range[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals .. CJK Symbols (含 U+3000 全角空格)
  [0x3041, 0x33ff], // Hiragana .. CJK Compatibility
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe6f], // CJK Compatibility Forms / Small Form Variants
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji
  [0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
  [0x20000, 0x2fffd], // CJK Ext B ..
  [0x30000, 0x3fffd], // CJK Ext G ..
];

function inRanges(ranges: readonly Range[], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

export type CharWidth = 0 | 1 | 2;

/** 查表返回字符宽度：0 组合标记，2 宽字符，1 其余。 */
export function charWidth(codePoint: number): CharWidth {
  if (inRanges(ZERO_WIDTH_RANGES, codePoint)) return 0;
  if (inRanges(WIDE_RANGES, codePoint)) return 2;
  return 1;
}
