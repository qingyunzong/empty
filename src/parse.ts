import {
  CompiledGrammar,
  CompiledRule,
  GrammarInput,
  compileGrammar,
  validateSequence,
} from './grammar';
import { RuleNode, TreeNode, preorderRuleIds } from './tree';
import { Certificate } from './certificate';

export interface ParseOptions {
  /**
   * Optional cost budget. The solver is exact, so with a budget it still
   * computes the true optimum and reports whether it fits:
   *   - optimum <= budget        -> status 'optimal'
   *   - optimum >  budget        -> status 'over-budget' (a parse exists)
   *   - no parse exists at all   -> status 'infeasible'
   * Without a budget the result is simply 'optimal' or 'infeasible'.
   */
  budget?: number;
}

export interface ParseSuccess {
  status: 'optimal' | 'over-budget';
  /** Minimum achievable cost. */
  cost: number;
  /** Echo of the budget when one was supplied. */
  budget?: number;
  /** A minimum-cost parse tree. */
  tree: RuleNode;
  /** Leftmost derivation as a rule-ID sequence (preorder of the tree). */
  ruleIds: number[];
  /** Independently checkable derivation certificate. */
  certificate: Certificate;
}

export interface ParseInfeasible {
  status: 'infeasible';
  reason: string;
}

export type ParseResult = ParseSuccess | ParseInfeasible;

type ChildRef =
  | { kind: 'nt'; nt: string; i: number; j: number }
  | { kind: 't'; value: string };

interface BackPointer {
  ruleId: number;
  children: ChildRef[];
}

const INFINITY_COST = Number.POSITIVE_INFINITY;

function key(nt: string, i: number, j: number): string {
  return `${nt} ${i} ${j}`;
}

/**
 * Exact minimum-cost parse.
 *
 * Items are (nonterminal, i, j) meaning "this nonterminal derives
 * sequence[i..j)". We compute the minimum cost of every item by chaotic
 * relaxation (Bellman-Ford style fixpoint) over the derivation hypergraph:
 * each rule A -> X1..Xk with cost c contributes candidate derivations
 * cost c + sum(costs of child items). Because all costs are non-negative,
 * an optimal derivation tree never needs to repeat an item on a
 * root-to-leaf path (a repeated item spans a removable non-negative-cost
 * cycle), so depth <= number of items suffices and the fixpoint provably
 * converges in at most that many sweeps. This also makes feasibility
 * decidable: 'infeasible' is exact, never "unknown".
 */
export function parse(
  grammarInput: GrammarInput,
  sequenceInput: readonly string[],
  options: ParseOptions = {},
): ParseResult {
  const grammar = compileGrammar(grammarInput);
  const sequence = validateSequence(sequenceInput);
  const budget = options.budget;
  if (budget !== undefined) {
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
      throw new Error('budget must be a non-negative finite number');
    }
  }

  const n = sequence.length;
  const dist = new Map<string, number>();
  const back = new Map<string, BackPointer>();

  const getDist = (nt: string, i: number, j: number): number => {
    const d = dist.get(key(nt, i, j));
    return d === undefined ? INFINITY_COST : d;
  };

  // One relaxation sweep over all rules; returns true if anything improved.
  const sweep = (): boolean => {
    let changed = false;

    const consider = (
      rule: CompiledRule,
      start: number,
      end: number,
      childCost: number,
      children: ChildRef[],
    ): void => {
      const total = rule.cost + childCost;
      if (total < getDist(rule.lhs, start, end)) {
        dist.set(key(rule.lhs, start, end), total);
        back.set(key(rule.lhs, start, end), { ruleId: rule.id, children: children.slice() });
        changed = true;
      }
    };

    const relaxRule = (rule: CompiledRule): void => {
      const k = rule.rhs.length;
      // Recursively assign a span to every rhs symbol, starting at `from`.
      const rec = (
        idx: number,
        from: number,
        spanStart: number,
        childCost: number,
        children: ChildRef[],
      ): void => {
        if (idx === k) {
          consider(rule, spanStart, from, childCost, children);
          return;
        }
        const sym = rule.rhs[idx]!;
        if (sym.kind === 'terminal') {
          if (from < n && sequence[from] === sym.value) {
            children.push({ kind: 't', value: sym.value });
            rec(idx + 1, from + 1, spanStart, childCost, children);
            children.pop();
          }
          return;
        }
        for (let end = from; end <= n; end++) {
          const d = getDist(sym.value, from, end);
          if (d === INFINITY_COST) continue;
          children.push({ kind: 'nt', nt: sym.value, i: from, j: end });
          rec(idx + 1, end, spanStart, childCost + d, children);
          children.pop();
        }
      };
      for (let s = 0; s <= n; s++) rec(0, s, s, 0, []);
    };

    for (const rule of grammar.rules) relaxRule(rule);
    return changed;
  };

  // Convergence bound: one sweep per item is more than enough (see above).
  const itemCount = grammar.nonterminals.size * ((n + 1) * (n + 2)) / 2;
  const maxSweeps = itemCount + 2;
  let sweeps = 0;
  while (sweep()) {
    sweeps++;
    if (sweeps > maxSweeps) {
      // Unreachable with non-negative costs; guards against future regressions.
      throw new Error('internal error: relaxation did not converge');
    }
  }

  const best = getDist(grammar.start, 0, n);
  if (best === INFINITY_COST) {
    return {
      status: 'infeasible',
      reason: `no derivation of the sequence from start symbol '${grammar.start}' exists (at any cost)`,
    };
  }

  // Reconstruct one optimal tree by following back-pointers. The pointer
  // graph is acyclic: along every edge parent -> child we have
  // dist(parent) >= dist(child) + (non-negative rule cost), and every edge
  // was installed by a strictly improving update, so no cycle can close.
  const buildTree = (nt: string, i: number, j: number): RuleNode => {
    const bp = back.get(key(nt, i, j));
    if (!bp) throw new Error('internal error: missing back-pointer');
    const children: TreeNode[] = bp.children.map((c) =>
      c.kind === 't' ? { terminal: c.value } : buildTree(c.nt, c.i, c.j),
    );
    return { ruleId: bp.ruleId, symbol: nt, children };
  };

  const tree = buildTree(grammar.start, 0, n);
  const ruleIds = preorderRuleIds(tree);
  const certificate: Certificate = {
    start: grammar.start,
    sequence,
    cost: best,
    ruleIds,
    tree,
  };

  const status = budget !== undefined && best > budget ? 'over-budget' : 'optimal';
  const result: ParseSuccess = { status, cost: best, tree, ruleIds, certificate };
  if (budget !== undefined) result.budget = budget;
  return result;
}
