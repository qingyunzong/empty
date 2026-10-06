import {
  availableWidth,
  buildModel,
  compareSequences,
  isBetter,
  lineWidthOf,
  validateOptions,
  widowOrphanOk,
  wordCountOf,
  type Model,
} from "./model.js";
import type {
  Certificate,
  LayoutInput,
  LayoutOptions,
  LayoutResult,
  LineSpan,
} from "./types.js";

interface Entry {
  cost: number;
  seq: number[];
}

function keyOf(frag: number, k: number, prevHyphen: number): string {
  return `${frag}|${k}|${prevHyphen}`;
}

/** Explicit pre-checks for unbreakable content that can never fit. */
export function unbreakableFailure(input: LayoutInput, model: Model): LayoutResult | null {
  const F = model.fragments.length;
  for (let i = 0; i < F; i++) {
    const f = model.fragments[i];
    if (f.fragIndex > 0) continue;
    if (f.fragCount === 1 && f.width > input.lineWidth) {
      return {
        ok: false,
        reason: "unbreakable-word-too-wide",
        word: f.text,
        width: f.width,
        limit: input.lineWidth,
      };
    }
    if (f.fragCount > 1) {
      let maxFrag = 0;
      let word = "";
      for (let j = i; j < i + f.fragCount; j++) {
        if (model.fragments[j].width > maxFrag) {
          maxFrag = model.fragments[j].width;
          word = model.words[f.wordIndex].text;
        }
      }
      if (maxFrag > input.lineWidth) {
        return {
          ok: false,
          reason: "unbreakable-fragment-too-wide",
          word,
          width: maxFrag,
          limit: input.lineWidth,
        };
      }
    }
  }
  return null;
}

/** Solve the optimal line-breaking problem.
 *
 *  Objective: minimize the sum of squared remaining widths over all lines
 *  except the last (the last line is free). Ties are broken by choosing
 *  the lexicographically smallest breakpoint sequence.
 *
 *  DP state: (fragment index, line index, hyphenations used, whether the
 *  previous line ended with a hyphen). The line index and previous-line
 *  flag form the state that determines each line's available width
 *  (floats + hyphen carry). */
export function solveLayout(input: LayoutInput): LayoutResult {
  validate(input);
  const built = buildModel(input);
  if (!built.ok) return built;
  const model = built.model;
  const F = model.fragments.length;
  if (F === 0) {
    return {
      ok: true,
      bound: 0,
      certificate: { breakpoints: [], lines: [], hyphenations: 0, totalCost: 0 },
    };
  }
  const failure = unbreakableFailure(input, model);
  if (failure) return failure;

  let hyphenBoundaries = 0;
  for (let i = 1; i < F; i++) if (model.hyphenAt[i]) hyphenBoundaries++;
  const K = Math.min(input.maxHyphenations ?? hyphenBoundaries, hyphenBoundaries);

  let best: Entry | null = null;
  let layer = new Map<string, Entry>();
  layer.set(keyOf(0, 0, 0), { cost: 0, seq: [] });

  for (let lineIdx = 0; layer.size > 0; lineIdx++) {
    const next = new Map<string, Entry>();
    for (const [key, entry] of layer) {
      const [a, usedK, prev] = key.split("|").map(Number);
      const avail = availableWidth(lineIdx, prev === 1, input);
      for (let b = a + 1; b <= F; b++) {
        if (b < F && !model.breakable[b]) continue;
        const w = lineWidthOf(model, a, b);
        // Future widths can drop by at most one hyphen width (when a
        // hyphenated line end is extended past the word boundary).
        if (w - model.hyphenWidth > avail) break;
        if (w > avail) continue;
        const hyph = b < F && model.hyphenAt[b];
        const usedK2 = usedK + (hyph ? 1 : 0);
        if (usedK2 > K) continue;
        const isLast = b === F;
        const totalLines = lineIdx + 1;
        if (
          isLast &&
          input.minLastLineWords !== undefined &&
          totalLines > 1 &&
          wordCountOf(model, a, F) < input.minLastLineWords
        ) {
          continue;
        }
        const slack = avail - w;
        const cand: Entry = {
          cost: entry.cost + (isLast ? 0 : slack * slack),
          seq: isLast ? entry.seq : [...entry.seq, b],
        };
        if (isLast) {
          if (widowOrphanOk(totalLines, input) && (!best || isBetter(cand, best))) {
            best = cand;
          }
        } else {
          const k2 = keyOf(b, usedK2, hyph ? 1 : 0);
          const cur = next.get(k2);
          if (!cur || isBetter(cand, cur)) next.set(k2, cand);
        }
      }
    }
    layer = next;
  }

  if (!best) return { ok: false, reason: "no-feasible-layout" };
  const certificate = replay(model, input, best.seq);
  return { ok: true, bound: certificate.totalCost, certificate };
}

function validate(input: LayoutInput): void {
  validateOptions(input);
}

/** Rebuild every line span from a breakpoint sequence and recompute the
 *  total cost. Shared by the solver (certificate construction) and the
 *  certificate verifier. */
export function replay(
  model: Model,
  opts: LayoutOptions,
  breakpoints: number[],
): Certificate {
  const F = model.fragments.length;
  const bounds = [0, ...breakpoints, F];
  const lines: LineSpan[] = [];
  let prevHyphen = false;
  let totalCost = 0;
  let hyphenations = 0;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    const width = lineWidthOf(model, a, b);
    const available = availableWidth(i, prevHyphen, opts);
    const isLast = b === F;
    const slack = available - width;
    const cost = isLast ? 0 : slack * slack;
    const endsWithHyphen = b < F && model.hyphenAt[b];
    if (endsWithHyphen) hyphenations++;
    let text = "";
    for (let j = a; j < b; j++) {
      if (j > a && model.fragments[j].wordIndex !== model.fragments[j - 1].wordIndex) {
        text += " ";
      }
      text += model.fragments[j].text;
    }
    if (endsWithHyphen) text += "-";
    lines.push({
      lineIndex: i,
      startFragment: a,
      endFragment: b,
      startWord: model.fragments[a].wordIndex,
      endWord: model.fragments[b - 1].wordIndex + 1,
      charStart: model.fragments[a].charStart,
      charEnd: model.fragments[b - 1].charEnd,
      text,
      width,
      available,
      slack,
      endsWithHyphen,
      cost,
    });
    totalCost += cost;
    prevHyphen = endsWithHyphen;
  }
  return { breakpoints: [...breakpoints], lines, hyphenations, totalCost };
}

export { compareSequences };
