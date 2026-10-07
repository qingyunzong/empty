import {
  availWidth,
  assemble,
  buildModel,
  lineContentWidth,
  Model,
} from './layout';
import { LayoutOutcome } from './types';

const MAX_ENUMERATED_BOUNDARIES = 22;

/**
 * Reference implementation: enumerates every subset of allowed break
 * boundaries (full enumeration / 全切分) and picks the optimum with the same
 * tie-break rule as `layout`. Exponential — intended for verifying the DP on
 * short texts only.
 */
export function layoutBruteForce(options: Parameters<typeof buildModel>[0]): LayoutOutcome {
  if (options.words.length === 0) {
    return { ok: true, cost: 0, breaks: [], lines: [], hyphenations: 0 };
  }
  const built = buildModel(options);
  if ('ok' in built) return built;
  const model: Model = built;

  const N = model.atoms.length;
  const allowed: number[] = [];
  for (let b = 1; b < N; b++) if (model.boundary[b]) allowed.push(b);
  if (allowed.length > MAX_ENUMERATED_BOUNDARIES) {
    throw new Error(
      `brute force limited to ${MAX_ENUMERATED_BOUNDARIES} break boundaries, got ${allowed.length}`,
    );
  }

  let best: { cost: number; boundaries: number[] } | null = null;
  const total = 1 << allowed.length;
  for (let mask = 0; mask < total; mask++) {
    const boundaries: number[] = [];
    let hyphens = 0;
    for (let k = 0; k < allowed.length; k++) {
      if (mask & (1 << k)) {
        const b = allowed[k];
        boundaries.push(b);
        if (model.boundary[b] === 'hyphen') hyphens++;
      }
    }
    if (hyphens > model.maxHyphenations) continue;

    // Segment atoms into lines at the chosen boundaries.
    const segments: Array<[number, number]> = [];
    let prev = 0;
    for (const b of boundaries) {
      segments.push([prev, b - 1]);
      prev = b;
    }
    segments.push([prev, N - 1]);

    let cost = 0;
    let feasible = true;
    for (let s = 0; s < segments.length; s++) {
      const [a, b] = segments[s];
      const lineNo = s + 1;
      const avail = availWidth(model, lineNo);
      const isLast = s === segments.length - 1;
      const hyphenated = !isLast && model.boundary[b + 1] === 'hyphen';
      const w =
        lineContentWidth(model, a, b) + (hyphenated ? model.hyphenWidth : 0);
      if (w > avail) {
        feasible = false;
        break;
      }
      const wc = model.atoms[b].word - model.atoms[a].word + 1;
      if (s === 0 && wc < model.minFirst) {
        feasible = false;
        break;
      }
      if (isLast) {
        if (wc < model.minLast) {
          feasible = false;
        }
      } else {
        cost += (avail - w) * (avail - w);
      }
      if (!feasible) break;
    }
    if (!feasible) continue;

    if (
      !best ||
      cost < best.cost ||
      (cost === best.cost && lexLess(boundaries, best.boundaries))
    ) {
      best = { cost, boundaries };
    }
  }

  if (!best) {
    return {
      ok: false,
      kind: 'infeasible',
      reason:
        'no feasible line breaking satisfies the width, image, hyphenation and widow/orphan constraints',
    };
  }
  return assemble(model, best);
}

function lexLess(a: number[], b: number[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}
