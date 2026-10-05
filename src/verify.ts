import type { Segment } from "./pattern.js";
import { collectLiterals } from "./pattern.js";
import { matchPath } from "./match.js";
import { smallestNonLiteral, compareBytes } from "./alphabet.js";
import { searchIntersection, DEFAULT_BUDGET, type SearchResult } from "./search.js";

/**
 * Exhaustively enumerate all paths over `alphabet` with up to `maxLen`
 * segments, in (segment count, byte order), and return the first one that
 * matches both allow patterns and no exclude pattern. This is the
 * short-domain ground truth used to accept the witness produced by the
 * symbolic search.
 */
export function exhaustiveWitness(
  allowA: Segment[],
  allowB: Segment[],
  excludes: Segment[][],
  alphabet: string[],
  maxLen: number,
): string[] | null {
  const sorted = [...alphabet].sort(compareBytes);
  const accepted = (path: string[]): boolean =>
    matchPath(allowA, path) &&
    matchPath(allowB, path) &&
    excludes.every((pattern) => !matchPath(pattern, path));

  for (let length = 0; length <= maxLen; length++) {
    const indices = new Array<number>(length).fill(0);
    for (;;) {
      const path = indices.map((k) => sorted[k]!);
      if (accepted(path)) return path;
      let pos = length - 1;
      while (pos >= 0 && indices[pos] === sorted.length - 1) pos--;
      if (pos < 0) break;
      indices[pos]!++;
      for (let q = pos + 1; q < length; q++) indices[q] = 0;
    }
  }
  return null;
}

/** Alphabet covering every literal plus the concretized τ symbol. */
export function domainAlphabet(patterns: Segment[][]): string[] {
  const literals = collectLiterals(patterns);
  const tau = smallestNonLiteral(new Set(literals));
  return [...new Set([...literals, tau])].sort(compareBytes);
}

export interface CrossCheckResult {
  consistent: boolean;
  search: SearchResult;
  domain: { alphabet: string[]; maxLen: number; witness: string[] | null };
  note: string;
}

/**
 * Cross-check the symbolic search against short-domain exhaustion. The
 * domain covers every literal in play plus the τ concretization, so a
 * shortest global witness of length ≤ maxLen is always inside the domain.
 */
export function crossCheck(
  allowA: Segment[],
  allowB: Segment[],
  excludes: Segment[][],
  maxLen: number,
  budget: number = DEFAULT_BUDGET,
): CrossCheckResult {
  const search = searchIntersection(allowA, allowB, excludes, budget);
  const alphabet = domainAlphabet([allowA, allowB, ...excludes]);
  const domainWitness = exhaustiveWitness(allowA, allowB, excludes, alphabet, maxLen);
  const domain = { alphabet, maxLen, witness: domainWitness };

  if (search.status === "unknown") {
    return { consistent: false, search, domain, note: "search budget exhausted" };
  }
  if (search.status === "disjoint") {
    const consistent = domainWitness === null;
    return {
      consistent,
      search,
      domain,
      note: consistent
        ? "disjoint confirmed by exhaustive domain"
        : "exhaustive domain found a witness the search missed",
    };
  }
  if (search.witness.length > maxLen) {
    const consistent = domainWitness === null;
    return {
      consistent,
      search,
      domain,
      note: consistent
        ? `witness length ${search.witness.length} exceeds domain; domain found nothing shorter`
        : "exhaustive domain found a shorter witness than the search",
    };
  }
  const consistent =
    domainWitness !== null &&
    domainWitness.length === search.witness.length &&
    domainWitness.every((seg, k) => seg === search.witness[k]);
  return {
    consistent,
    search,
    domain,
    note: consistent
      ? "shortest witness accepted by exhaustive domain"
      : "search witness disagrees with exhaustive domain",
  };
}
