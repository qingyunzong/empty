import type {
  FloatImage,
  LayoutFailure,
  LayoutInput,
  LayoutOptions,
  WordSpec,
} from "./types.js";

export const SOFT_HYPHEN = "\u00AD";
export const NBSP = "\u00A0";

export interface Fragment {
  wordIndex: number;
  fragIndex: number;
  fragCount: number;
  text: string;
  width: number;
  charStart: number;
  charEnd: number;
}

export interface Model {
  words: WordSpec[];
  fragments: Fragment[];
  /** breakable[i]: a line may end before fragment i (1 <= i < F). */
  breakable: boolean[];
  /** hyphenAt[i]: boundary i lies inside a word (hyphenated break). */
  hyphenAt: boolean[];
  spaceWidth: number;
  hyphenWidth: number;
  /** Paragraph rendered with single spaces / NBSP for glued pairs. */
  joined: string;
  /** fragWidthPrefix[i] = sum of widths of fragments [0, i). */
  fragWidthPrefix: number[];
  /** wordBoundaryPrefix[i] = number of word boundaries among 1..i. */
  wordBoundaryPrefix: number[];
}

export type BuildResult =
  | { ok: true; model: Model }
  | { ok: false; reason: LayoutFailure["reason"]; char?: string; word?: string };

export function validateOptions(opts: LayoutOptions): void {
  if (!Number.isInteger(opts.lineWidth) || opts.lineWidth <= 0) {
    throw new TypeError("lineWidth must be a positive integer");
  }
  const intOpt = (v: number | undefined, name: string, min: number) => {
    if (v !== undefined && (!Number.isInteger(v) || v < min)) {
      throw new TypeError(`${name} must be an integer >= ${min}`);
    }
  };
  intOpt(opts.maxHyphenations, "maxHyphenations", 0);
  intOpt(opts.pageHeight, "pageHeight", 1);
  intOpt(opts.minLinesAtPageEdge, "minLinesAtPageEdge", 1);
  intOpt(opts.startLineOffset, "startLineOffset", 0);
  intOpt(opts.minLastLineWords, "minLastLineWords", 1);
  const nonNeg = (v: number | undefined, name: string) => {
    if (v !== undefined && (!(v >= 0) || !Number.isFinite(v))) {
      throw new TypeError(`${name} must be a finite number >= 0`);
    }
  };
  nonNeg(opts.hyphenCarryWidth, "hyphenCarryWidth");
  for (const f of opts.floats ?? []) {
    intOpt(f.startLine, "float.startLine", 0);
    intOpt(f.lineCount, "float.lineCount", 1);
    if (Array.isArray(f.width)) {
      if (f.width.length !== f.lineCount) {
        throw new TypeError("float.width array must have lineCount entries");
      }
      f.width.forEach((w, i) => nonNeg(w, `float.width[${i}]`));
    } else {
      nonNeg(f.width, "float.width");
    }
  }
}

export function buildModel(input: LayoutInput): BuildResult {
  const { words, widths } = input;
  for (const [ch, w] of Object.entries(widths)) {
    if (!(w >= 0) || !Number.isFinite(w)) {
      throw new TypeError(`width of ${JSON.stringify(ch)} must be a finite number >= 0`);
    }
  }
  const spaceWidth = widths[" "];
  if (spaceWidth === undefined) {
    return { ok: false, reason: "missing-char-width", char: " " };
  }
  const hyphenWidth = widths["-"];
  if (hyphenWidth === undefined) {
    return { ok: false, reason: "missing-char-width", char: "-" };
  }

  const fragments: Fragment[] = [];
  let joined = "";
  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi];
    if (wi > 0) joined += words[wi - 1].glueAfter ? NBSP : " ";
    if (word.text.length === 0) {
      return { ok: false, reason: "empty-word" };
    }
    const pieces = word.text.split(SOFT_HYPHEN);
    if (pieces.some((p) => p.length === 0)) {
      return { ok: false, reason: "malformed-soft-break", word: word.text };
    }
    for (let fi = 0; fi < pieces.length; fi++) {
      const text = pieces[fi];
      let width = 0;
      for (const ch of text) {
        const w = widths[ch];
        if (w === undefined) {
          return { ok: false, reason: "missing-char-width", char: ch, word: word.text };
        }
        width += w;
      }
      const charStart = joined.length;
      joined += text;
      fragments.push({
        wordIndex: wi,
        fragIndex: fi,
        fragCount: pieces.length,
        text,
        width,
        charStart,
        charEnd: joined.length,
      });
    }
  }

  const F = fragments.length;
  const breakable = new Array<boolean>(F).fill(false);
  const hyphenAt = new Array<boolean>(F).fill(false);
  for (let i = 1; i < F; i++) {
    if (fragments[i].wordIndex === fragments[i - 1].wordIndex) {
      breakable[i] = true;
      hyphenAt[i] = true;
    } else {
      breakable[i] = !words[fragments[i - 1].wordIndex].glueAfter;
    }
  }

  const fragWidthPrefix = new Array<number>(F + 1).fill(0);
  const wordBoundaryPrefix = new Array<number>(F).fill(0);
  for (let i = 0; i < F; i++) {
    fragWidthPrefix[i + 1] = fragWidthPrefix[i] + fragments[i].width;
    wordBoundaryPrefix[i] =
      (i > 0 ? wordBoundaryPrefix[i - 1] : 0) +
      (i > 0 && fragments[i].wordIndex !== fragments[i - 1].wordIndex ? 1 : 0);
  }

  return {
    ok: true,
    model: {
      words,
      fragments,
      breakable,
      hyphenAt,
      spaceWidth,
      hyphenWidth,
      joined,
      fragWidthPrefix,
      wordBoundaryPrefix,
    },
  };
}

/** Width of a line holding fragments [a, b). Adds the hyphen width when
 *  the line ends mid-word. */
export function lineWidthOf(model: Model, a: number, b: number): number {
  const fragW = model.fragWidthPrefix[b] - model.fragWidthPrefix[a];
  const innerWordBoundaries =
    model.wordBoundaryPrefix[b - 1] - model.wordBoundaryPrefix[a];
  let w = fragW + innerWordBoundaries * model.spaceWidth;
  const last = model.fragments[b - 1];
  if (last.fragIndex < last.fragCount - 1) w += model.hyphenWidth;
  return w;
}

/** Number of distinct words covered by fragments [a, b). */
export function wordCountOf(model: Model, a: number, b: number): number {
  return model.fragments[b - 1].wordIndex - model.fragments[a].wordIndex + 1;
}

/** Width available on paragraph line `lineIndex`: base width minus float
 *  intrusion, minus the carry penalty when the previous line ended with a
 *  hyphen (state-dependent line width). */
export function availableWidth(
  lineIndex: number,
  prevHyphen: boolean,
  opts: LayoutOptions,
): number {
  let w = opts.lineWidth;
  for (const f of opts.floats ?? []) {
    if (lineIndex >= f.startLine && lineIndex < f.startLine + f.lineCount) {
      w -= floatWidthOnLine(f, lineIndex - f.startLine);
    }
  }
  if (prevHyphen) w -= opts.hyphenCarryWidth ?? 0;
  return w;
}

function floatWidthOnLine(f: FloatImage, offset: number): number {
  return Array.isArray(f.width) ? f.width[offset] ?? 0 : f.width;
}

/** Page-based widow/orphan control: every page that carries paragraph
 *  lines must hold at least `minLinesAtPageEdge` of them, unless the
 *  paragraph starts or ends on that page's only carried lines... precisely:
 *  a page may not contain fewer than `m` paragraph lines while the
 *  paragraph continues on another page. */
export function widowOrphanOk(totalLines: number, opts: LayoutOptions): boolean {
  const H = opts.pageHeight;
  if (H === undefined || totalLines === 0) return true;
  const m = opts.minLinesAtPageEdge ?? 2;
  const o = opts.startLineOffset ?? 0;
  const firstPage = Math.floor(o / H);
  const lastPage = Math.floor((o + totalLines - 1) / H);
  for (let p = firstPage; p <= lastPage; p++) {
    const from = Math.max(o, p * H);
    const to = Math.min(o + totalLines, (p + 1) * H);
    const count = to - from;
    if (p !== firstPage && count < m) return false; // widow at page top
    if (p !== lastPage && count < m) return false; // orphan at page bottom
  }
  return true;
}

/** Compare breakpoint sequences: lexicographic, a proper prefix is
 *  smaller. */
export function compareSequences(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Candidate ordering: lower cost wins; ties go to the lexicographically
 *  smaller breakpoint sequence. */
export function isBetter(
  cand: { cost: number; seq: number[] },
  cur: { cost: number; seq: number[] },
): boolean {
  if (cand.cost !== cur.cost) return cand.cost < cur.cost;
  return compareSequences(cand.seq, cur.seq) < 0;
}
