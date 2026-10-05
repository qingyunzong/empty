/**
 * Exhaustive, DP-free cross-checking utilities for small grammars.
 *
 * bruteForceMinCost enumerates every derivation (run) of the input tree and
 * takes the minimum; enumerateTrees lists every tree the grammar can derive
 * within a depth bound. Both are exponential and intended for verification
 * of the dynamic-programming parser on small instances.
 */

import type { Grammar, Rule } from "./grammar.ts";
import { encodeSequence, type Tree } from "./tree.ts";

const SEP = String.fromCharCode(1);

export interface BruteForceResult {
  /** Minimum cost over all runs, or null when no run exists. */
  readonly cost: number | null;
  /** Rule ids (preorder) of a cheapest run, or null when none exists. */
  readonly ruleIds: readonly number[] | null;
  /** Number of complete runs examined. */
  readonly runs: number;
  /** True when enumeration stopped early at the run cap. */
  readonly capped: boolean;
}

interface Run {
  readonly cost: number;
  readonly ids: readonly number[];
}

/** Enumerates every run of the grammar on the given tree, tracking the minimum. */
export function bruteForceMinCost(
  grammar: Grammar,
  root: Tree,
  maxRuns = 1_000_000,
): BruteForceResult {
  const byLhsAndSymbol = new Map<string, Rule[]>();
  for (const rule of grammar.rules) {
    const key = rule.lhs + SEP + rule.symbol;
    const bucket = byLhsAndSymbol.get(key);
    if (bucket === undefined) byLhsAndSymbol.set(key, [rule]);
    else bucket.push(rule);
  }

  function* enumRuns(node: Tree, nonterminal: string): Generator<Run> {
    const candidates = byLhsAndSymbol.get(nonterminal + SEP + node.symbol) ?? [];
    for (const rule of candidates) {
      let partials: Run[] = [{ cost: rule.cost, ids: [rule.id] }];
      for (let k = 0; k < rule.children.length; k += 1) {
        const next: Run[] = [];
        for (const partial of partials) {
          for (const sub of enumRuns(node.children[k], rule.children[k])) {
            next.push({ cost: partial.cost + sub.cost, ids: [...partial.ids, ...sub.ids] });
          }
        }
        partials = next;
        if (partials.length === 0) break;
      }
      yield* partials;
    }
  }

  let runs = 0;
  let bestCost = Infinity;
  let bestIds: readonly number[] | null = null;
  let capped = false;
  for (const run of enumRuns(root, grammar.start)) {
    runs += 1;
    if (runs > maxRuns) {
      capped = true;
      runs -= 1;
      break;
    }
    if (run.cost < bestCost) {
      bestCost = run.cost;
      bestIds = run.ids;
    }
  }
  return {
    cost: bestIds === null ? null : bestCost,
    ruleIds: bestIds,
    runs,
    capped,
  };
}

/**
 * Every tree derivable from the start symbol within the given depth bound
 * (deduplicated, at most `cap` trees). Depth counts edges on the longest
 * root-to-leaf path; leaves have depth 0.
 */
export function enumerateTrees(grammar: Grammar, maxDepth: number, cap = 10_000): Tree[] {
  const memo = new Map<string, Tree[]>();
  const derive = (nonterminal: string, depth: number): Tree[] => {
    const key = nonterminal + SEP + depth;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const result: Tree[] = [];
    for (const rule of grammar.rules) {
      if (rule.lhs !== nonterminal) continue;
      if (rule.children.length === 0) {
        result.push({ symbol: rule.symbol, children: [] });
      } else if (depth > 0) {
        let partials: Tree[][] = [[]];
        for (const childNonterminal of rule.children) {
          const subs = derive(childNonterminal, depth - 1);
          const next: Tree[][] = [];
          for (const partial of partials) {
            for (const sub of subs) next.push([...partial, sub]);
          }
          partials = next;
          if (partials.length === 0) break;
        }
        for (const kids of partials) result.push({ symbol: rule.symbol, children: kids });
      }
    }
    memo.set(key, result);
    return result;
  };

  const seen = new Set<string>();
  const out: Tree[] = [];
  for (const candidate of derive(grammar.start, maxDepth)) {
    const key = encodeSequence(candidate).join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= cap) break;
  }
  return out;
}
