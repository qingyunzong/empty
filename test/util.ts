import type { MatchInfo } from "../src/index.js";

/** Deterministic PRNG so random tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

const ALPHABET = ["a", "b", "c", "d", "e", "x", "y", " ", ".", "😀", "β"];

export function randomText(rng: () => number, maxLen = 24): string {
  const n = randInt(rng, 0, maxLen);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += ALPHABET[randInt(rng, 0, ALPHABET.length - 1)];
  }
  return s;
}

/** Code-unit offsets of every code-point boundary of `s`. */
function boundaries(s: string): number[] {
  const b = [0];
  for (const ch of s) b.push(b[b.length - 1] + ch.length);
  return b;
}

/**
 * Random sorted, non-overlapping matches aligned to code-point boundaries.
 * Zero-length matches are allowed. Every match gets `groupCount` defined
 * capture groups (indices 1..groupCount) inside its own span.
 */
export function randomMatches(
  rng: () => number,
  text: string,
  groupCount: number,
): MatchInfo[] {
  const b = boundaries(text);
  const n = b.length - 1;
  const matches: MatchInfo[] = [];
  const count = randInt(rng, 0, 3);
  let pos = 0;
  for (let k = 0; k < count; k++) {
    const startCh = randInt(rng, pos, n);
    const endCh = randInt(rng, startCh, n);
    pos = endCh;
    const captures = [];
    for (let g = 0; g < groupCount; g++) {
      const gs = randInt(rng, startCh, endCh);
      const ge = randInt(rng, gs, endCh);
      captures.push({ start: b[gs], end: b[ge] });
    }
    matches.push({
      start: b[startCh],
      end: b[endCh],
      captures: [undefined, ...captures],
    });
  }
  return matches;
}

/** Random template referencing only captures 0..groupCount. */
export function randomTemplate(rng: () => number, groupCount: number): string {
  const pieces = randInt(rng, 0, 4);
  let out = "";
  for (let i = 0; i < pieces; i++) {
    const choice = randInt(rng, 0, 3);
    if (choice === 0) {
      const len = randInt(rng, 1, 3);
      for (let k = 0; k < len; k++) {
        out += ALPHABET[randInt(rng, 0, ALPHABET.length - 1)];
      }
    } else if (choice === 1) {
      out += "$$";
    } else if (choice === 2) {
      out += rng() < 0.5 ? "$&" : "$0";
    } else {
      out += `$${randInt(rng, 0, groupCount)}`;
    }
  }
  return out;
}

/**
 * Reconstructs the expected inverse-query ranges for source position `s`
 * from a label array: maximal output runs with consecutive source labels
 * whose label interval contains `s`.
 */
export function expectedRanges(
  labels: number[],
  s: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < labels.length) {
    if (labels[i] < 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < labels.length && labels[j + 1] === labels[j] + 1) j += 1;
    if (labels[i] <= s && s <= labels[j]) {
      ranges.push({ start: i, end: j + 1 });
    }
    i = j + 1;
  }
  return ranges;
}
