import {
  BreakKind,
  FloatingImage,
  LayoutFailure,
  LayoutOptions,
  LayoutOutcome,
  LayoutSuccess,
  LineSpan,
} from './types';

/** An atom is an unbreakable fragment of a word (between soft breaks). */
interface Atom {
  word: number;
  start: number; // char offset inside the word (inclusive)
  end: number; // char offset inside the word (exclusive)
  width: number;
}

export interface Model {
  atoms: Atom[];
  /** boundary[b] for 1 <= b <= N-1: break kind allowed after atom b-1, or null. */
  boundary: Array<BreakKind | null>;
  words: LayoutOptions['words'];
  spaceWidth: number;
  hyphenWidth: number;
  maxWidth: number;
  maxHyphenations: number;
  reserved: Map<number, number>;
  minFirst: number;
  minLast: number;
  prefixWidth: number[]; // prefixWidth[i] = sum of atom widths [0, i)
  prefixSpaces: number[]; // prefixSpaces[i] = number of word boundaries in [0, i)
}

function charWidth(
  widths: Readonly<Record<string, number>>,
  ch: string,
): number {
  const w = widths[ch];
  if (w === undefined) {
    throw new Error(`missing width for character ${JSON.stringify(ch)}`);
  }
  return w;
}

export function buildModel(options: LayoutOptions): Model | LayoutFailure {
  const {
    words,
    widths,
    spaceWidth,
    maxWidth,
    hyphenWidth = 0,
    maxHyphenations = Number.POSITIVE_INFINITY,
    images = [],
    minFirstLineWords = 1,
    minLastLineWords = 1,
  } = options;

  if (!Number.isInteger(maxWidth) || maxWidth <= 0) {
    throw new Error('maxWidth must be a positive integer');
  }

  const atoms: Atom[] = [];
  for (let wi = 0; wi < words.length; wi++) {
    const spec = words[wi];
    if (spec.text.length === 0) {
      throw new Error(`word ${wi} is empty`);
    }
    const cuts = [0, ...(spec.softBreaks ?? []), spec.text.length];
    for (let k = 1; k < cuts.length; k++) {
      if (cuts[k] <= cuts[k - 1]) {
        throw new Error(`word ${wi}: soft breaks must be strictly increasing`);
      }
    }
    for (let k = 0; k + 1 < cuts.length; k++) {
      const start = cuts[k];
      const end = cuts[k + 1];
      let width = 0;
      for (let c = start; c < end; c++) {
        width += charWidth(widths, spec.text[c]);
      }
      atoms.push({ word: wi, start, end, width });
    }
  }

  // Explicit failure: an unbreakable fragment wider than any possible line.
  for (const atom of atoms) {
    if (atom.width > maxWidth) {
      const spec = words[atom.word];
      return {
        ok: false,
        kind: 'unbreakable-overflow',
        wordIndex: atom.word,
        text: spec.text,
        width: atom.width,
        limit: maxWidth,
      };
    }
  }

  const boundary: Array<BreakKind | null> = new Array(atoms.length).fill(null);
  for (let b = 1; b < atoms.length; b++) {
    const prev = atoms[b - 1];
    const next = atoms[b];
    if (prev.word === next.word) {
      boundary[b] = 'hyphen';
    } else if (!words[prev.word].keepWithNext) {
      boundary[b] = 'space';
    }
  }

  const reserved = new Map<number, number>();
  for (const img of images) {
    if (!Number.isInteger(img.line) || img.line < 1) {
      throw new Error(`image line must be a positive integer, got ${img.line}`);
    }
    reserved.set(img.line, (reserved.get(img.line) ?? 0) + img.width);
  }

  // prefixSpaces[i] = number of word boundaries at positions 1..i, where
  // boundary b sits between atom b-1 and atom b.
  const prefixWidth = new Array(atoms.length + 1).fill(0);
  const prefixSpaces = new Array(atoms.length + 1).fill(0);
  for (let i = 0; i < atoms.length; i++) {
    prefixWidth[i + 1] = prefixWidth[i] + atoms[i].width;
    prefixSpaces[i + 1] =
      prefixSpaces[i] + (i + 1 < atoms.length && atoms[i + 1].word !== atoms[i].word ? 1 : 0);
  }

  const totalWords = words.length;
  return {
    atoms,
    boundary,
    words,
    spaceWidth,
    hyphenWidth,
    maxWidth,
    maxHyphenations,
    reserved,
    minFirst: Math.min(Math.max(1, minFirstLineWords), Math.max(1, totalWords)),
    minLast: Math.min(Math.max(1, minLastLineWords), Math.max(1, totalWords)),
    prefixWidth,
    prefixSpaces,
  };
}

export function availWidth(model: Model, lineNo: number): number {
  return model.maxWidth - (model.reserved.get(lineNo) ?? 0);
}

/** Width of atoms [a, b] on one line, excluding any trailing hyphen. */
export function lineContentWidth(model: Model, a: number, b: number): number {
  const fragments = model.prefixWidth[b + 1] - model.prefixWidth[a];
  const spaces = model.prefixSpaces[b] - model.prefixSpaces[a];
  return fragments + spaces * model.spaceWidth;
}

function wordsOnLine(model: Model, a: number, b: number): number {
  return model.atoms[b].word - model.atoms[a].word + 1;
}

/** Lexicographic comparison of break-boundary sequences. */
function lexLess(a: number[], b: number[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

interface Candidate {
  cost: number;
  boundaries: number[];
}

function better(x: Candidate, y: Candidate): boolean {
  if (x.cost !== y.cost) return x.cost < y.cost;
  return lexLess(x.boundaries, y.boundaries);
}

/**
 * Core search. Returns the optimal (cost, break boundaries) or null when no
 * feasible breaking exists. A boundary b means "new line starts at atom b".
 */
export function solveModel(model: Model): Candidate | null {
  const { atoms, boundary, hyphenWidth } = model;
  const N = atoms.length;
  if (N === 0) return { cost: 0, boundaries: [] };

  let hyphenBoundaries = 0;
  for (let b = 1; b < N; b++) if (boundary[b] === 'hyphen') hyphenBoundaries++;
  const K = Math.min(model.maxHyphenations, hyphenBoundaries);

  // dp: key `${i}|${h}|${l}` = atoms [0,i) typeset in l complete lines using
  // h hyphenations. The line number of the next line is l+1, so image
  // reservations (state formed by previous breaks) are fully determined.
  const dp = new Map<string, Candidate>();
  const key = (i: number, h: number, l: number) => `${i}|${h}|${l}`;
  dp.set(key(0, 0, 0), { cost: 0, boundaries: [] });

  for (let i = 0; i < N; i++) {
    for (let h = 0; h <= K; h++) {
      for (let l = 0; l <= N; l++) {
        const st = dp.get(key(i, h, l));
        if (!st) continue;
        const avail = availWidth(model, l + 1);
        for (let j = i; j < N - 1; j++) {
          const content = lineContentWidth(model, i, j);
          if (content > avail) break; // widths are non-negative
          const kind = boundary[j + 1];
          if (!kind) continue;
          const w = content + (kind === 'hyphen' ? hyphenWidth : 0);
          if (w > avail) continue;
          const nh = h + (kind === 'hyphen' ? 1 : 0);
          if (nh > K) continue;
          if (l === 0 && wordsOnLine(model, i, j) < model.minFirst) continue;
          const slack = avail - w;
          const next: Candidate = {
            cost: st.cost + slack * slack,
            boundaries: [...st.boundaries, j + 1],
          };
          const k2 = key(j + 1, nh, l + 1);
          const cur = dp.get(k2);
          if (!cur || better(next, cur)) dp.set(k2, next);
        }
      }
    }
  }

  // Close the paragraph with a free (unpenalized) last line.
  let best: Candidate | null = null;
  for (const [k, st] of dp) {
    const [i, , l] = k.split('|').map(Number);
    const avail = availWidth(model, l + 1);
    if (lineContentWidth(model, i, N - 1) > avail) continue;
    const wc = wordsOnLine(model, i, N - 1);
    if (wc < model.minLast) continue;
    if (l === 0 && wc < model.minFirst) continue;
    if (!best || better(st, best)) best = st;
  }
  return best;
}

function lineText(model: Model, a: number, b: number, hyphenated: boolean): string {
  let text = '';
  for (let i = a; i <= b; i++) {
    const atom = model.atoms[i];
    if (i > a && atom.word !== model.atoms[i - 1].word) text += ' ';
    text += model.words[atom.word].text.slice(atom.start, atom.end);
  }
  return hyphenated ? text + '-' : text;
}

/** Assemble the public result (line spans + breakpoint certificate). */
export function assemble(model: Model, solution: Candidate): LayoutSuccess {
  const N = model.atoms.length;
  const lines: LineSpan[] = [];
  const breaks = solution.boundaries.map((b) => ({
    afterAtom: b - 1,
    afterWord: model.atoms[b - 1].word,
    kind: model.boundary[b] as BreakKind,
  }));

  let start = 0;
  const stops = [...solution.boundaries, N];
  for (const b of stops) {
    const end = b - 1;
    const lineNo = lines.length + 1;
    const hyphenated = b < N && model.boundary[b] === 'hyphen';
    const width =
      lineContentWidth(model, start, end) + (hyphenated ? model.hyphenWidth : 0);
    const reserved = model.reserved.get(lineNo) ?? 0;
    const avail = model.maxWidth - reserved;
    lines.push({
      line: lineNo,
      startWord: model.atoms[start].word,
      endWord: model.atoms[end].word,
      startOffset: model.atoms[start].start,
      endOffset: model.atoms[end].end,
      text: lineText(model, start, end, hyphenated),
      width,
      reserved,
      slack: avail - width,
      hyphenated,
    });
    start = b;
  }

  return {
    ok: true,
    cost: solution.cost,
    breaks,
    lines,
    hyphenations: breaks.filter((bp) => bp.kind === 'hyphen').length,
  };
}

const INFEASIBLE: LayoutFailure = {
  ok: false,
  kind: 'infeasible',
  reason:
    'no feasible line breaking satisfies the width, image, hyphenation and widow/orphan constraints',
};

/**
 * Optimal line breaking.
 *
 * Minimizes the sum of squared slack over all lines except the last (which is
 * free); ties are broken by the lexicographically smallest breakpoint
 * sequence. Returns an explicit failure for overwide unbreakable words and
 * for constraint infeasibility.
 */
export function layout(options: LayoutOptions): LayoutOutcome {
  if (options.words.length === 0) {
    return { ok: true, cost: 0, breaks: [], lines: [], hyphenations: 0 };
  }
  const model = buildModel(options);
  if ('ok' in model) return model;
  const solution = solveModel(model);
  if (!solution) return INFEASIBLE;
  return assemble(model, solution);
}
