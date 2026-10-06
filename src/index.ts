export type {
  Certificate,
  FloatImage,
  LayoutFailure,
  LayoutInput,
  LayoutOptions,
  LayoutResult,
  LayoutSuccess,
  LineSpan,
  WidthTable,
  WordSpec,
} from "./types.js";
export {
  NBSP,
  SOFT_HYPHEN,
  availableWidth,
  buildModel,
  compareSequences,
  lineWidthOf,
  widowOrphanOk,
  type Model,
} from "./model.js";
export { replay, solveLayout } from "./solve.js";
export { solveBruteForce } from "./brute.js";
export { verifyCertificate, type Verification } from "./verify.js";

import { NBSP, SOFT_HYPHEN } from "./model.js";
import { solveLayout } from "./solve.js";
import type { LayoutOptions, LayoutResult, WidthTable, WordSpec } from "./types.js";

/** Split a plain string into words. Regular spaces separate words;
 *  U+00A0 glues words into an unbreakable region; U+00AD marks soft
 *  (in-word) break points. */
export function parseText(text: string): WordSpec[] {
  const words: WordSpec[] = [];
  for (const token of text.split(" ")) {
    if (token === "") continue;
    const parts = token.split(NBSP);
    parts.forEach((part, i) => {
      words.push({ text: part, glueAfter: i < parts.length - 1 });
    });
  }
  return words;
}

/** Convenience wrapper: lay out a plain-text paragraph. */
export function layoutText(
  input: LayoutOptions & { text: string; widths: WidthTable },
): LayoutResult {
  const { text, ...rest } = input;
  return solveLayout({ ...rest, words: parseText(text) });
}

/** Build a width table assigning `width` to every character of `chars`
 *  (space and hyphen default to `width` unless overridden). */
export function uniformWidths(
  chars: string,
  width = 1,
  overrides: Record<string, number> = {},
): WidthTable {
  const table: WidthTable = { " ": width, "-": width };
  for (const ch of chars) table[ch] = width;
  return Object.assign(table, overrides);
}

export { SOFT_HYPHEN as SHY };
