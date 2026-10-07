/** A word with optional soft (hyphenation) break points. */
export interface WordSpec {
  /** The word text. Widths are looked up per character in the width table. */
  text: string;
  /**
   * Character offsets (0 < off < text.length, ascending) where the word may
   * be hyphenated. Fragments between consecutive soft breaks are unbreakable.
   */
  softBreaks?: number[];
  /** If true, no line break is allowed in the space after this word. */
  keepWithNext?: boolean;
}

/** A floating image reserving `width` units on a specific 1-based line. */
export interface FloatingImage {
  /** 1-based line number the image floats beside. */
  line: number;
  /** Width reserved by the image on that line. */
  width: number;
}

export interface LayoutOptions {
  words: WordSpec[];
  /** Character width table: every character of every word must be present. */
  widths: Readonly<Record<string, number>>;
  /** Width of the inter-word space. */
  spaceWidth: number;
  /** Extra width added to a line that ends at a soft break (the hyphen). */
  hyphenWidth?: number;
  /** Maximum line width (integer). */
  maxWidth: number;
  /** Maximum number of hyphenation breaks allowed in the whole paragraph. */
  maxHyphenations?: number;
  /** Floating images reserving width on specific lines. */
  images?: FloatingImage[];
  /** Orphan control: minimum words on the first line (default 1). */
  minFirstLineWords?: number;
  /** Widow control: minimum words on the last line (default 1). */
  minLastLineWords?: number;
}

export type BreakKind = 'space' | 'hyphen';

/** One breakpoint of the optimal solution (the certificate). */
export interface Breakpoint {
  /** 0-based index of the last atom (word fragment) on the line. */
  afterAtom: number;
  /** 0-based index of the last word on the line. */
  afterWord: number;
  kind: BreakKind;
}

/** A typeset line, described as a span over the input words. */
export interface LineSpan {
  /** 1-based line number. */
  line: number;
  startWord: number;
  endWord: number;
  /** Character offset inside the start word where the line begins. */
  startOffset: number;
  /** Character offset (exclusive) inside the end word where the line stops. */
  endOffset: number;
  /** Visible text of the line (including a trailing '-' if hyphenated). */
  text: string;
  /** Content width of the line (including hyphen when hyphenated). */
  width: number;
  /** Width reserved by floating images on this line. */
  reserved: number;
  /** Remaining width: (maxWidth - reserved) - width. */
  slack: number;
  /** True when the line ends at a soft break inside a word. */
  hyphenated: boolean;
}

export interface LayoutSuccess {
  ok: true;
  /** Optimal bound: minimal sum of squared slack over all non-last lines. */
  cost: number;
  /** Breakpoint certificate: the optimal break sequence. */
  breaks: Breakpoint[];
  /** Line spans of the paragraph. */
  lines: LineSpan[];
  /** Number of hyphenation breaks used. */
  hyphenations: number;
}

export type LayoutFailure =
  | {
      ok: false;
      kind: 'unbreakable-overflow';
      /** Word that can never fit, even alone on a line. */
      wordIndex: number;
      text: string;
      width: number;
      limit: number;
    }
  | {
      ok: false;
      kind: 'infeasible';
      reason: string;
    };

export type LayoutOutcome = LayoutSuccess | LayoutFailure;
