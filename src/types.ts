/** Character width table. Must contain entries for every character used,
 *  plus ' ' (space) and '-' (hyphen). Widths are finite numbers >= 0;
 *  integer widths are recommended so that cost ties are exact. */
export interface WidthTable {
  [char: string]: number;
}

/** One input word. `text` may contain soft-hyphen markers (U+00AD) that
 *  denote legal in-word break points. `glueAfter` joins this word to the
 *  next one with an unbreakable space (an unbreakable region). */
export interface WordSpec {
  text: string;
  glueAfter?: boolean;
}

/** A floating image that steals width from a range of paragraph lines.
 *  `startLine` is a 0-based paragraph line index; `width` is either a
 *  single width for every affected line or a per-line array of length
 *  `lineCount` (variable width per line). */
export interface FloatImage {
  startLine: number;
  lineCount: number;
  width: number | number[];
}

export interface LayoutOptions {
  /** Maximum line width. Must be a positive integer. */
  lineWidth: number;
  /** Maximum number of hyphenated (in-word) breaks, K. Default: unbounded. */
  maxHyphenations?: number;
  /** Floating images occupying width on specified lines. */
  floats?: FloatImage[];
  /** Width removed from any line that follows a line ending in a hyphen
   *  (line width depends on the previous line's breakpoint state). */
  hyphenCarryWidth?: number;
  /** Page height in lines, enables page-based widow/orphan control. */
  pageHeight?: number;
  /** Minimum paragraph lines allowed at a page edge. Default 2. */
  minLinesAtPageEdge?: number;
  /** Absolute line index of the paragraph's first line (page math). */
  startLineOffset?: number;
  /** Last line must hold at least this many words unless the paragraph
   *  fits on a single line. Default: no constraint. */
  minLastLineWords?: number;
}

export interface LayoutInput extends LayoutOptions {
  words: WordSpec[];
  widths: WidthTable;
}

/** One output line's span. */
export interface LineSpan {
  lineIndex: number;
  /** Fragment range [startFragment, endFragment). */
  startFragment: number;
  endFragment: number;
  /** Word range [startWord, endWord). */
  startWord: number;
  endWord: number;
  /** Character offsets into the joined paragraph string. */
  charStart: number;
  charEnd: number;
  /** Rendered line text (single spaces, trailing '-' if hyphenated). */
  text: string;
  /** Used width, available width, and remaining width (slack). */
  width: number;
  available: number;
  slack: number;
  /** True if the line ends mid-word with a hyphen. */
  endsWithHyphen: boolean;
  /** slack^2, or 0 for the last line (last line is not penalized). */
  cost: number;
}

/** Breakpoint certificate: replaying `breakpoints` must reproduce
 *  `lines` and `totalCost` (see verifyCertificate). */
export interface Certificate {
  /** Fragment boundary indices where lines break (excludes the final
   *  end-of-text boundary). */
  breakpoints: number[];
  lines: LineSpan[];
  hyphenations: number;
  totalCost: number;
}

export type LayoutFailure = {
  ok: false;
  reason:
    | "missing-char-width"
    | "malformed-soft-break"
    | "empty-word"
    | "unbreakable-word-too-wide"
    | "unbreakable-fragment-too-wide"
    | "no-feasible-layout";
  word?: string;
  char?: string;
  width?: number;
  limit?: number;
};

export type LayoutSuccess = {
  ok: true;
  /** Optimal bound: minimal achievable sum of squared slacks. */
  bound: number;
  certificate: Certificate;
};

export type LayoutResult = LayoutSuccess | LayoutFailure;
