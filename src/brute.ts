import {
  availableWidth,
  buildModel,
  isBetter,
  lineWidthOf,
  validateOptions,
  widowOrphanOk,
  wordCountOf,
} from "./model.js";
import { replay, unbreakableFailure } from "./solve.js";
import type { LayoutInput, LayoutResult } from "./types.js";

const MAX_FRAGMENTS = 24;

/** Reference solver: enumerates every legal segmentation (full
 *  enumeration of all break-point sets) and returns the optimum under the
 *  same objective and tie-break as solveLayout. Exponential; intended for
 *  short texts only (used to cross-check the DP solver). */
export function solveBruteForce(input: LayoutInput): LayoutResult {
  validateOptions(input);
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
  if (F > MAX_FRAGMENTS) {
    throw new Error(`brute force limited to ${MAX_FRAGMENTS} fragments, got ${F}`);
  }
  const failure = unbreakableFailure(input, model);
  if (failure) return failure;
  const K = input.maxHyphenations ?? F;

  const holder: { best: { cost: number; seq: number[] } | null } = { best: null };

  function rec(a: number, lineIdx: number, usedK: number, prevHyphen: boolean, cost: number, seq: number[]): void {
    if (holder.best && cost > holder.best.cost) return;
    const avail = availableWidth(lineIdx, prevHyphen, input);
    for (let b = a + 1; b <= F; b++) {
      if (b < F && !model.breakable[b]) continue;
      const w = lineWidthOf(model, a, b);
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
      const cost2 = cost + (isLast ? 0 : slack * slack);
      if (isLast) {
        if (!widowOrphanOk(totalLines, input)) continue;
        const cand = { cost: cost2, seq };
        if (!holder.best || isBetter(cand, holder.best)) holder.best = cand;
      } else {
        rec(b, lineIdx + 1, usedK2, hyph, cost2, [...seq, b]);
      }
    }
  }
  rec(0, 0, 0, false, 0, []);

  const best = holder.best;
  if (!best) return { ok: false, reason: "no-feasible-layout" };
  const certificate = replay(model, input, best.seq);
  return { ok: true, bound: certificate.totalCost, certificate };
}
