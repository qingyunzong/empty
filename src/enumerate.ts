import { CompiledRule, GrammarInput, compileGrammar, validateSequence } from './grammar';
import { RuleNode, TreeNode, treeCost } from './tree';

export interface EnumerationResult {
  /** All parse trees of depth <= maxDepth (complete unless `truncated`). */
  trees: RuleNode[];
  /** Number of trees found (== trees.length). */
  count: number;
  /** True if the tree cap was hit and the enumeration is incomplete. */
  truncated: boolean;
  /** Minimum cost among the enumerated trees, or null if there are none. */
  minCost: number | null;
}

/**
 * Depth bound that makes bounded enumeration complete: an optimal (or any
 * minimal) derivation never repeats an item (nonterminal, i, j) on a
 * root-to-leaf path, because the cycle between the repetitions has
 * non-negative cost and can be removed without increasing the total cost.
 * Hence every feasible item has a derivation of depth at most the number of
 * distinct items.
 */
export function completenessBound(grammar: GrammarInput, sequenceLength: number): number {
  const compiled = compileGrammar(grammar);
  const n = sequenceLength;
  return compiled.nonterminals.size * ((n + 1) * (n + 2)) / 2;
}

/**
 * Brute-force oracle: enumerate every parse tree of the sequence up to a
 * depth bound. Used to cross-check the DP solver on small grammars.
 * Terminates even with recursive/zero-cost rules because of the depth bound.
 */
export function enumerateParses(
  grammarInput: GrammarInput,
  sequenceInput: readonly string[],
  maxDepth: number,
  cap = 100_000,
): EnumerationResult {
  const grammar = compileGrammar(grammarInput);
  const sequence = validateSequence(sequenceInput);
  const n = sequence.length;

  const memo = new Map<string, RuleNode[]>();
  let count = 0;
  let truncated = false;

  const enumItem = (nt: string, i: number, j: number, depth: number): RuleNode[] => {
    if (depth <= 0 || truncated) return [];
    const memoKey = `${nt} ${i} ${j} ${depth}`;
    const cached = memo.get(memoKey);
    if (cached) return cached;
    const out: RuleNode[] = [];
    for (const rule of grammar.rulesByLhs.get(nt) ?? []) {
      for (const children of enumChildren(rule, 0, i, j, depth)) {
        out.push({ ruleId: rule.id, symbol: nt, children });
        count++;
        if (count >= cap) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    memo.set(memoKey, out);
    return out;
  };

  // All ways to match rule.rhs[idx..] against sequence[pos..end).
  const enumChildren = (
    rule: CompiledRule,
    idx: number,
    pos: number,
    end: number,
    depth: number,
  ): TreeNode[][] => {
    if (truncated) return [];
    if (idx === rule.rhs.length) return pos === end ? [[]] : [];
    const sym = rule.rhs[idx]!;
    if (sym.kind === 'terminal') {
      if (pos < end && sequence[pos] === sym.value) {
        return enumChildren(rule, idx + 1, pos + 1, end, depth).map((rest) => [
          { terminal: sym.value },
          ...rest,
        ]);
      }
      return [];
    }
    const out: TreeNode[][] = [];
    for (let mid = pos; mid <= end; mid++) {
      for (const sub of enumItem(sym.value, pos, mid, depth - 1)) {
        for (const rest of enumChildren(rule, idx + 1, mid, end, depth)) {
          out.push([sub, ...rest]);
          if (count + out.length >= cap) {
            truncated = true;
            return out;
          }
        }
      }
    }
    return out;
  };

  const trees = enumItem(grammar.start, 0, n, maxDepth);
  let minCost: number | null = null;
  const costOf = (ruleId: number): number => grammar.ruleById.get(ruleId)!.cost;
  for (const tree of trees) {
    const c = treeCost(tree, costOf);
    if (minCost === null || c < minCost) minCost = c;
  }
  return { trees, count: trees.length, truncated, minCost };
}
