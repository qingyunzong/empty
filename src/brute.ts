import { decodeAll } from "./utf8";
import type { Fragment } from "./analyzer";

// Independent reference implementation used to verify StreamAnalyzer:
// fully lex the input, then enumerate every substring. Kept deliberately
// separate from the incremental code so the two cross-check each other.

const QUOTE_SINGLE = 0x27; // '
const QUOTE_DOUBLE = 0x22; // "
const QUOTE_BACKTICK = 0x60; // `
const BACKSLASH = 0x5c; // \
const ESCAPE = -1;

/**
 * normal[i] is true when the lexical stack is empty immediately before the
 * code point at index i (normal[n] describes the end of input).
 */
export function computeNormalBoundaries(cps: number[]): boolean[] {
  const normal = new Array<boolean>(cps.length + 1);
  const stack: number[] = []; // quote code points; ESCAPE marks an escape frame
  for (let i = 0; i <= cps.length; i++) {
    normal[i] = stack.length === 0;
    if (i === cps.length) {
      break;
    }
    const cp = cps[i];
    const top = stack[stack.length - 1];
    if (top === ESCAPE) {
      stack.pop();
    } else if (top !== undefined) {
      if (cp === BACKSLASH) {
        stack.push(ESCAPE);
      } else if (cp === top) {
        stack.pop();
      }
    } else if (cp === QUOTE_SINGLE || cp === QUOTE_DOUBLE || cp === QUOTE_BACKTICK) {
      stack.push(cp);
    }
  }
  return normal;
}

/**
 * Longest substring with all-distinct code points whose start and end fall
 * on legal lexical boundaries. Ties broken by earliest start. O(n^2).
 */
export function bruteForceBest(bytes: Uint8Array): Fragment | null {
  const { cps, starts, ends } = decodeAll(bytes);
  const n = cps.length;
  const normal = computeNormalBoundaries(cps);
  let best: Fragment | null = null;
  for (let i = 0; i < n; i++) {
    if (!normal[i]) {
      continue;
    }
    const seen = new Set<number>();
    for (let j = i; j < n; j++) {
      if (seen.has(cps[j])) {
        break;
      }
      seen.add(cps[j]);
      if (!normal[j + 1]) {
        continue;
      }
      const length = j - i + 1;
      if (best === null || length > best.length) {
        best = {
          startIndex: i,
          endIndex: j,
          startByte: starts[i],
          endByte: ends[j],
          length,
        };
      }
    }
  }
  return best;
}
