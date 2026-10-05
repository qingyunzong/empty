/**
 * Finite regular tree grammar with non-negative per-rule costs.
 *
 * A rule `A -> f(B1, ..., Bn)` rewrites nonterminal `A` into a node labelled
 * with terminal symbol `f` (of rank n) whose children are nonterminals.
 * Recursive rules (A reachable from itself) are allowed.
 */

export interface Rule {
  /** Unique rule identifier; reported in derivations and certificates. */
  readonly id: number;
  /** Left-hand side nonterminal. */
  readonly lhs: string;
  /** Terminal (ranked alphabet) symbol labelling the produced tree node. */
  readonly symbol: string;
  /** Child nonterminals; length must equal arity[symbol]. */
  readonly children: readonly string[];
  /** Non-negative rule cost. */
  readonly cost: number;
}

export interface Grammar {
  /** Ranked alphabet: terminal symbol -> arity (>= 0). */
  readonly arity: Readonly<Record<string, number>>;
  /** Nonterminal symbols. */
  readonly nonterminals: readonly string[];
  /** Start nonterminal. */
  readonly start: string;
  /** Production rules. */
  readonly rules: readonly Rule[];
}

export class GrammarError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super("invalid grammar:\n" + problems.map((p) => "  - " + p).join("\n"));
    this.name = "GrammarError";
    this.problems = problems;
  }
}

/** Throws GrammarError listing every problem found; returns void when valid. */
export function validateGrammar(g: Grammar): void {
  const problems: string[] = [];

  for (const [symbol, ar] of Object.entries(g.arity)) {
    if (!Number.isInteger(ar) || ar < 0) {
      problems.push(`arity of symbol ${JSON.stringify(symbol)} must be a non-negative integer, got ${ar}`);
    }
  }

  const nonterminals = new Set(g.nonterminals);
  if (!nonterminals.has(g.start)) {
    problems.push(`start symbol ${JSON.stringify(g.start)} is not declared as a nonterminal`);
  }

  const seenIds = new Set<number>();
  g.rules.forEach((rule, index) => {
    const where = `rule[${index}] (id=${rule.id})`;
    if (!Number.isInteger(rule.id)) {
      problems.push(`${where}: rule id must be an integer, got ${rule.id}`);
    } else if (seenIds.has(rule.id)) {
      problems.push(`${where}: duplicate rule id ${rule.id}`);
    }
    seenIds.add(rule.id);

    if (!nonterminals.has(rule.lhs)) {
      problems.push(`${where}: lhs ${JSON.stringify(rule.lhs)} is not a declared nonterminal`);
    }

    const ar = g.arity[rule.symbol];
    if (ar === undefined) {
      problems.push(`${where}: symbol ${JSON.stringify(rule.symbol)} is not in the ranked alphabet`);
    } else if (rule.children.length !== ar) {
      problems.push(
        `${where}: symbol ${JSON.stringify(rule.symbol)} has arity ${ar} but the rule has ${rule.children.length} children`,
      );
    }

    for (const child of rule.children) {
      if (!nonterminals.has(child)) {
        problems.push(`${where}: child ${JSON.stringify(child)} is not a declared nonterminal`);
      }
    }

    if (typeof rule.cost !== "number" || !Number.isFinite(rule.cost) || rule.cost < 0) {
      problems.push(`${where}: cost must be a finite non-negative number, got ${rule.cost}`);
    }
  });

  if (problems.length > 0) throw new GrammarError(problems);
}
