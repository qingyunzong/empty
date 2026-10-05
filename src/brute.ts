// Reference oracle: lexes the whole buffer from scratch, then enumerates all
// substrings to find the longest one with distinct code points and legal
// lexical boundaries. Used to cross-check the incremental analyzer.

import { decodeCodePoints, nextState, ST, type LexState } from "./core.ts";
import type { BestSegment } from "./analyzer.ts";

export function fullAnalysis(data: Uint8Array): BestSegment | null {
  const { cps, widths } = decodeCodePoints(data);
  const n = cps.length;

  const stateAt: number[] = new Array(n + 1);
  stateAt[0] = ST.NORMAL;
  const byteOff: number[] = new Array(n + 1);
  byteOff[0] = 0;
  for (let i = 0; i < n; i++) {
    stateAt[i + 1] = nextState(stateAt[i] as LexState, cps[i]);
    byteOff[i + 1] = byteOff[i] + widths[i];
  }

  let best: [number, number] | null = null;
  for (let s = 0; s < n; s++) {
    if (stateAt[s] !== ST.NORMAL) continue;
    const seen = new Set<number>();
    for (let e = s; e < n; e++) {
      if (seen.has(cps[e])) break;
      seen.add(cps[e]);
      if (stateAt[e + 1] === ST.NORMAL) {
        const len = e - s + 1;
        if (best === null || len > best[1] - best[0]) best = [s, e + 1];
      }
    }
  }
  if (best === null) return null;
  const [cpStart, cpEnd] = best;
  return {
    cpStart,
    cpEnd,
    length: cpEnd - cpStart,
    byteStart: byteOff[cpStart],
    byteEnd: byteOff[cpEnd],
    text: String.fromCodePoint(...cps.slice(cpStart, cpEnd)),
  };
}
