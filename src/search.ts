import { Seg } from "./pattern";
import { Nfa, buildNfa, closure, step } from "./nfa";

export interface SearchOptions {
  /** Max number of frontier states to expand before giving up. */
  budget?: number;
  /** Max witness length in segments; hitting it degrades EMPTY to UNKNOWN. */
  maxDepth?: number;
}

export type SearchResult =
  | { status: "witness"; path: string[]; expansions: number }
  | { status: "empty"; expansions: number }
  | { status: "unknown"; reason: string; expansions: number };

export const DEFAULT_BUDGET = 100_000;
export const DEFAULT_MAX_DEPTH = 256;

/**
 * The byte-smallest lowercase string that is not in `literals`.
 * Always of the form "a"*i: any string containing a non-'a' character is
 * byte-greater than some pure-"a" string, and the pure-"a" strings cannot all
 * be taken because the literal set is finite.
 */
export function smallestMissingLiteral(literals: ReadonlySet<string>): string {
  let s = "a";
  while (literals.has(s)) s += "a";
  return s;
}

interface FrontierNode {
  masks: number[];
  depth: number;
  str: string; // minimal concrete path realising this symbolic path
}

function lessNode(a: FrontierNode, b: FrontierNode): boolean {
  if (a.depth !== b.depth) return a.depth < b.depth;
  return a.str < b.str;
}

/** Binary min-heap ordered by (segment count, byte order of the path). */
class Heap {
  private items: FrontierNode[] = [];
  get size(): number {
    return this.items.length;
  }
  push(node: FrontierNode): void {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (lessNode(items[i]!, items[parent]!)) {
        [items[i], items[parent]] = [items[parent]!, items[i]!];
        i = parent;
      } else break;
    }
  }
  pop(): FrontierNode | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < items.length && lessNode(items[l]!, items[smallest]!)) smallest = l;
        if (r < items.length && lessNode(items[r]!, items[smallest]!)) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Decide whether the two allow patterns share a path that no exclude pattern
 * matches, and if so return the witness with the fewest segments, breaking
 * ties by byte order of the '/'-joined path.
 *
 * Method: best-first search over a symbolic product automaton. Each pattern
 * becomes an NFA; the search state is one subset-construction mask per
 * pattern (allows are kept as subsets too, which is exact). The symbolic
 * alphabet is every literal appearing in the rule set plus one "other" letter
 * covering all remaining segments; its minimal concrete representative is the
 * byte-smallest string not used as a literal. Because appending segments
 * strictly increases the (depth, bytes) key and preserves its order, the
 * first accepting state popped from the frontier yields the minimal witness.
 *
 * Outcomes: "witness" (found), "empty" (frontier fully exhausted, provably no
 * common path), or "unknown" (budget/depth limit hit, so neither is proven).
 */
export function findWitness(
  allow1: Seg[],
  allow2: Seg[],
  excludes: Seg[][],
  opts: SearchOptions = {}
): SearchResult {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  const allPatterns = [allow1, allow2, ...excludes];
  const nfas: Nfa[] = allPatterns.map(buildNfa);

  const literals = new Set<string>();
  for (const segs of allPatterns) {
    for (const s of segs) if (s.kind === "lit") literals.add(s.value);
  }
  const other = smallestMissingLiteral(literals);
  const symbols: Array<{ seg: string; lit: string | null }> = [
    ...[...literals].sort().map((l) => ({ seg: l, lit: l as string | null })),
    { seg: other, lit: null },
  ];

  const isAccept = (masks: number[]): boolean =>
    (masks[0]! & nfas[0]!.finalMask) !== 0 &&
    (masks[1]! & nfas[1]!.finalMask) !== 0 &&
    masks.slice(2).every((m, i) => (m & nfas[i + 2]!.finalMask) === 0);

  const heap = new Heap();
  const best = new Map<string, { depth: number; str: string }>();

  const push = (masks: number[], depth: number, str: string): void => {
    const key = masks.join(",");
    const rec = best.get(key);
    if (
      rec &&
      (rec.depth < depth || (rec.depth === depth && rec.str <= str))
    ) {
      return; // already have a no-worse way to reach this automaton state
    }
    best.set(key, { depth, str });
    heap.push({ masks, depth, str });
  };

  push(nfas.map((nfa) => closure(nfa, 1)), 0, "");

  let expansions = 0;
  let truncated = false;

  for (;;) {
    const node = heap.pop();
    if (node === undefined) {
      return truncated
        ? { status: "unknown", reason: `depth limit ${maxDepth} reached`, expansions }
        : { status: "empty", expansions };
    }
    const rec = best.get(node.masks.join(","))!;
    if (
      rec.depth < node.depth ||
      (rec.depth === node.depth && rec.str < node.str)
    ) {
      continue; // stale heap entry, a better key for this state exists
    }
    if (isAccept(node.masks)) {
      return {
        status: "witness",
        path: node.str === "" ? [] : node.str.split("/"),
        expansions,
      };
    }
    if (expansions >= budget) {
      return {
        status: "unknown",
        reason: `expansion budget ${budget} exhausted`,
        expansions,
      };
    }
    expansions++;
    if (node.depth >= maxDepth) {
      truncated = true;
      continue;
    }
    for (const sym of symbols) {
      const next = node.masks.map((m, i) => step(nfas[i]!, m, sym.lit));
      // A zero mask in an allow automaton is a dead end; a zero mask in an
      // exclude automaton just means the exclude can never match, which is
      // exactly what we want, so only the allows prune the frontier.
      if (next[0] === 0 || next[1] === 0) continue;
      push(next, node.depth + 1, node.depth === 0 ? sym.seg : `${node.str}/${sym.seg}`);
    }
  }
}
