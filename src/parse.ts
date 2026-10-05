/**
 * Minimum-cost parsing of a finite ranked tree (given as a prefix sequence)
 * against a finite regular tree grammar with non-negative rule costs.
 *
 * Bottom-up dynamic programming over the input tree:
 *   dp[node][A] = min over rules A -> f(B1..Bn) matching node.symbol of
 *                 rule.cost + sum(dp[child_k][B_k])
 * Because the input tree is finite, recursive grammar rules need no fixpoint
 * iteration; recursion is handled naturally by the bottom-up order.
 *
 * The result distinguishes three statuses:
 *   "optimal"     - a cheapest derivation exists and fits the budget (if any)
 *   "over-budget" - derivations exist, but the cheapest exceeds the budget
 *   "infeasible"  - no derivation of the input exists at all
 */

import { validateGrammar, type Grammar, type Rule } from "./grammar.ts";
import { decodeSequence, type Tree } from "./tree.ts";

export type ParseStatus = "optimal" | "over-budget" | "infeasible";

/**
 * Derivation certificate: the rule ids applied at each input-tree node in
 * preorder, plus the total cost. Independently checkable by verifyCertificate.
 */
export interface Certificate {
  readonly ruleIds: readonly number[];
  readonly cost: number;
}

export interface ParseResult {
  readonly status: ParseStatus;
  /** Optimal cost when the input is feasible, otherwise null. */
  readonly cost: number | null;
  /** The budget that was checked against, or null when none was given. */
  readonly budget: number | null;
  /** The decoded input tree. */
  readonly tree: Tree;
  /**
   * Cheapest derivation (rule ids in preorder). Present whenever the input is
   * feasible, including "over-budget" results, as evidence of the optimum.
   */
  readonly certificate: Certificate | null;
}

export interface ParseOptions {
  /** Non-negative cost budget; feasibility is still fully determined. */
  readonly budget?: number;
}

interface FlatNode {
  readonly symbol: string;
  readonly kids: readonly number[];
}

interface Cell {
  readonly cost: number;
  readonly ruleId: number;
}

interface Solved {
  readonly cost: number | null;
  readonly certificate: Certificate | null;
}

function solve(grammar: Grammar, root: Tree): Solved {
  // Flatten to postorder so children are always solved before their parent.
  const nodes: FlatNode[] = [];
  const flatten = (node: Tree): number => {
    const kids = node.children.map(flatten);
    nodes.push({ symbol: node.symbol, kids });
    return nodes.length - 1;
  };
  const rootIndex = flatten(root);

  const rulesBySymbol = new Map<string, Rule[]>();
  for (const rule of grammar.rules) {
    const bucket = rulesBySymbol.get(rule.symbol);
    if (bucket === undefined) rulesBySymbol.set(rule.symbol, [rule]);
    else bucket.push(rule);
  }

  const dp: Map<string, Cell>[] = nodes.map(() => new Map());
  nodes.forEach((node, index) => {
    const candidates = rulesBySymbol.get(node.symbol);
    if (candidates === undefined) return;
    const cell = dp[index];
    for (const rule of candidates) {
      let total = rule.cost;
      let usable = true;
      for (let k = 0; k < rule.children.length; k += 1) {
        const sub = dp[node.kids[k]].get(rule.children[k]);
        if (sub === undefined) {
          usable = false;
          break;
        }
        total += sub.cost;
      }
      if (!usable) continue;
      const current = cell.get(rule.lhs);
      if (current === undefined || total < current.cost) {
        cell.set(rule.lhs, { cost: total, ruleId: rule.id });
      }
    }
  });

  const best = dp[rootIndex].get(grammar.start);
  if (best === undefined) return { cost: null, certificate: null };

  // Backtrack from the root, emitting rule ids in preorder.
  const ruleById = new Map<number, Rule>(grammar.rules.map((rule) => [rule.id, rule]));
  const ruleIds: number[] = [];
  const emit = (nodeIndex: number, nonterminal: string): void => {
    const entry = dp[nodeIndex].get(nonterminal);
    if (entry === undefined) throw new Error("internal error: missing backpointer");
    ruleIds.push(entry.ruleId);
    const rule = ruleById.get(entry.ruleId);
    if (rule === undefined) throw new Error("internal error: unknown rule id");
    for (let k = 0; k < rule.children.length; k += 1) {
      emit(nodes[nodeIndex].kids[k], rule.children[k]);
    }
  };
  emit(rootIndex, grammar.start);

  return { cost: best.cost, certificate: { ruleIds, cost: best.cost } };
}

function finish(grammar: Grammar, root: Tree, options: ParseOptions): ParseResult {
  const budget = options.budget ?? null;
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) {
    throw new RangeError(`budget must be a finite non-negative number, got ${budget}`);
  }
  const { cost, certificate } = solve(grammar, root);
  let status: ParseStatus;
  if (cost === null) status = "infeasible";
  else if (budget !== null && cost > budget) status = "over-budget";
  else status = "optimal";
  return { status, cost, budget, tree: root, certificate };
}

/** Minimum-cost parse of an already-decoded tree. */
export function parseTree(grammar: Grammar, root: Tree, options: ParseOptions = {}): ParseResult {
  validateGrammar(grammar);
  return finish(grammar, root, options);
}

/**
 * Minimum-cost parse of a prefix-notation token sequence.
 * A malformed sequence raises SequenceError; a well-formed tree with no
 * derivation yields status "infeasible" instead.
 */
export function parseSequence(
  grammar: Grammar,
  sequence: readonly string[],
  options: ParseOptions = {},
): ParseResult {
  validateGrammar(grammar);
  return finish(grammar, decodeSequence(sequence, grammar.arity), options);
}
