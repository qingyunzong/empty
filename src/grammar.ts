/**
 * Grammar model.
 *
 * A grammar is a finite set of weighted rewriting rules over a sequence
 * alphabet (a weighted context-free / regular tree grammar over sequences).
 *
 *   - `lhs` is a nonterminal symbol.
 *   - `rhs` is a (possibly empty) sequence of symbols. A symbol is a
 *     nonterminal iff it appears as the `lhs` of some rule; otherwise it is
 *     a terminal. An empty `rhs` is an epsilon rule.
 *   - `cost` is a non-negative finite number. Recursive rules (the lhs
 *     occurring in its own rhs, directly or transitively) are allowed,
 *     including zero-cost cycles.
 */

export interface RuleInput {
  /** Unique rule identifier (integer). */
  id: number;
  /** Left-hand side nonterminal. */
  lhs: string;
  /** Right-hand side symbols (empty array = epsilon production). */
  rhs: string[];
  /** Non-negative rule cost. */
  cost: number;
}

export interface GrammarInput {
  /** Start (axiom) nonterminal. */
  start: string;
  rules: RuleInput[];
}

export type RhsSymbol =
  | { kind: 'terminal'; value: string }
  | { kind: 'nonterminal'; value: string };

export interface CompiledRule {
  id: number;
  lhs: string;
  rhs: RhsSymbol[];
  cost: number;
}

export interface CompiledGrammar {
  start: string;
  nonterminals: ReadonlySet<string>;
  rules: CompiledRule[];
  rulesByLhs: ReadonlyMap<string, CompiledRule[]>;
  ruleById: ReadonlyMap<number, CompiledRule>;
}

/** Validate and compile a grammar, resolving terminal vs nonterminal symbols. */
export function compileGrammar(input: GrammarInput): CompiledGrammar {
  if (input === null || typeof input !== 'object') {
    throw new Error('grammar must be an object with { start, rules }');
  }
  if (typeof input.start !== 'string' || input.start.length === 0) {
    throw new Error('grammar.start must be a non-empty string');
  }
  if (!Array.isArray(input.rules) || input.rules.length === 0) {
    throw new Error('grammar.rules must be a non-empty array');
  }
  const ids = new Set<number>();
  for (const rule of input.rules) {
    if (!Number.isInteger(rule.id)) {
      throw new Error(`rule id must be an integer, got ${String(rule.id)}`);
    }
    if (ids.has(rule.id)) {
      throw new Error(`duplicate rule id ${rule.id}`);
    }
    ids.add(rule.id);
    if (typeof rule.lhs !== 'string' || rule.lhs.length === 0) {
      throw new Error(`rule ${rule.id}: lhs must be a non-empty string`);
    }
    if (!Array.isArray(rule.rhs)) {
      throw new Error(`rule ${rule.id}: rhs must be an array of symbols`);
    }
    for (const sym of rule.rhs) {
      if (typeof sym !== 'string' || sym.length === 0) {
        throw new Error(`rule ${rule.id}: rhs symbols must be non-empty strings`);
      }
    }
    if (typeof rule.cost !== 'number' || !Number.isFinite(rule.cost) || rule.cost < 0) {
      throw new Error(`rule ${rule.id}: cost must be a non-negative finite number, got ${String(rule.cost)}`);
    }
  }

  const nonterminals = new Set<string>(input.rules.map((r) => r.lhs));
  const rules: CompiledRule[] = input.rules.map((r) => ({
    id: r.id,
    lhs: r.lhs,
    cost: r.cost,
    rhs: r.rhs.map((v): RhsSymbol =>
      nonterminals.has(v)
        ? { kind: 'nonterminal', value: v }
        : { kind: 'terminal', value: v },
    ),
  }));

  const rulesByLhs = new Map<string, CompiledRule[]>();
  const ruleById = new Map<number, CompiledRule>();
  for (const rule of rules) {
    const bucket = rulesByLhs.get(rule.lhs);
    if (bucket) bucket.push(rule);
    else rulesByLhs.set(rule.lhs, [rule]);
    ruleById.set(rule.id, rule);
  }

  return { start: input.start, nonterminals, rules, rulesByLhs, ruleById };
}

/** Validate a token sequence (the input to parse). */
export function validateSequence(sequence: readonly string[]): string[] {
  if (!Array.isArray(sequence)) {
    throw new Error('sequence must be an array of terminal symbols');
  }
  for (const token of sequence) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('sequence tokens must be non-empty strings');
    }
  }
  return sequence.slice();
}
