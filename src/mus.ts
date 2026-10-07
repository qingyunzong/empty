import type { Expr } from "./ast.js";
import { solveConjunction, MAX_CONSTRAINTS } from "./solver.js";

export interface NamedExpr {
  id: string;
  expr: Expr;
}

export interface SubsetCheck {
  ids: string[];
  sat: boolean;
  witness?: Record<string, boolean>;
}

/** Position from which an interrupted search can be resumed. */
export interface MusFrontier {
  size: number;
  comboIndex: number;
  rowIndex: number;
  checks: SubsetCheck[];
}

export type MusResult =
  | { status: "sat"; assignment: Record<string, boolean>; checks: SubsetCheck[] }
  | { status: "unsat"; mus: string[]; checks: SubsetCheck[] }
  | { status: "paused"; frontier: MusFrontier };

/**
 * Yields all k-combinations of `items` (which must be sorted) in
 * lexicographic tuple order.
 */
export function* combinations<T>(items: readonly T[], k: number): Generator<T[]> {
  if (k < 0 || k > items.length) return;
  const idx: number[] = [];
  for (let i = 0; i < k; i++) idx.push(i);
  while (true) {
    yield idx.map((i) => items[i] as T);
    let i = k - 1;
    while (i >= 0 && (idx[i] as number) === items.length - k + i) i--;
    if (i < 0) return;
    idx[i] = (idx[i] as number) + 1;
    for (let j = i + 1; j < k; j++) idx[j] = (idx[j - 1] as number) + 1;
  }
}

export interface MusSearchOptions {
  frontier?: MusFrontier;
  stepBudget?: number;
}

/**
 * Finds a minimum-cardinality unsatisfiable subset of the named
 * constraints. Subsets are enumerated by increasing cardinality and, within
 * one cardinality, in lexicographic order of the sorted id tuple, so the
 * first unsatisfiable subset found is both minimum and id-order smallest.
 * Every subset examined is recorded in `checks` together with a satisfying
 * witness, which is the explicit proof of minimality: all strictly smaller
 * subsets were independently checked and are satisfiable.
 *
 * If the whole set is satisfiable, returns its lexicographically smallest
 * assignment instead.
 */
export function findMinimumUnsatSubset(
  named: readonly NamedExpr[],
  vars: readonly string[],
  opts: MusSearchOptions = {}
): MusResult {
  if (named.length > MAX_CONSTRAINTS) {
    throw new Error(
      `exhaustive input limit exceeded: ${named.length} named constraints, at most ${MAX_CONSTRAINTS} allowed (2^${MAX_CONSTRAINTS} subsets)`
    );
  }
  const ids = named.map((c) => c.id).sort();
  const byId = new Map(named.map((c) => [c.id, c.expr]));
  const checks: SubsetCheck[] = opts.frontier ? [...opts.frontier.checks] : [];
  let budget = opts.stepBudget;
  const startSize = opts.frontier?.size ?? 0;
  const startCombo = opts.frontier?.comboIndex ?? 0;
  const startRow = opts.frontier?.rowIndex ?? 0;

  for (let size = startSize; size <= ids.length; size++) {
    let comboIndex = -1;
    for (const combo of combinations(ids, size)) {
      comboIndex++;
      if (size === startSize && comboIndex < startCombo) continue;
      const rowStart = size === startSize && comboIndex === startCombo ? startRow : 0;
      const exprs = combo.map((id) => {
        const e = byId.get(id);
        if (e === undefined) throw new Error(`unknown constraint id '${id}'`);
        return e;
      });
      const outcome = solveConjunction(exprs, {
        vars,
        startIndex: rowStart,
        ...(budget !== undefined ? { stepBudget: budget } : {}),
      });
      if (outcome.status === "paused") {
        return {
          status: "paused",
          frontier: { size, comboIndex, rowIndex: outcome.nextRowIndex, checks },
        };
      }
      if (budget !== undefined) budget -= outcome.steps;
      if (outcome.status === "unsat") {
        checks.push({ ids: combo, sat: false });
        return { status: "unsat", mus: combo, checks };
      }
      checks.push({ ids: combo, sat: true, witness: outcome.assignment });
      if (size === ids.length) {
        // The full set is satisfiable; its first satisfying row in
        // lexicographic scan order is the lexicographically smallest model.
        return { status: "sat", assignment: outcome.assignment, checks };
      }
    }
  }
  // Unreachable: the full set is always examined at size === ids.length.
  throw new Error("internal error: search terminated without a result");
}

function formatAssignment(assignment: Record<string, boolean>): string {
  return Object.keys(assignment)
    .sort()
    .map((v) => `${v}=${assignment[v] ? 1 : 0}`)
    .join(" ");
}

/**
 * Renders the unsatisfiability proof tree: the minimum unsatisfiable
 * subset at the root, every one-element-smaller subset of it as a
 * satisfiable child (with a concrete witness), and a summary line counting
 * all smaller subsets that were checked to establish minimality.
 */
export function renderProofTree(mus: readonly string[], checks: readonly SubsetCheck[]): string {
  const byKey = new Map(checks.map((c) => [JSON.stringify(c.ids), c]));
  const lines: string[] = [];
  lines.push(`UNSAT {${mus.join(", ")}}  -- minimum unsatisfiable subset, size ${mus.length}`);
  mus.forEach((id, i) => {
    const child = mus.filter((_, j) => j !== i);
    const rec = byKey.get(JSON.stringify(child));
    const branch = i === mus.length - 1 ? "└─" : "├─";
    const label = child.length === 0 ? "{}" : `{${child.join(", ")}}`;
    const witness =
      rec !== undefined && rec.witness !== undefined ? `  witness: ${formatAssignment(rec.witness)}` : "";
    lines.push(`${branch} ${label} SAT${witness}`);
  });
  const smaller = checks.filter((c) => c.ids.length < mus.length);
  lines.push(
    `minimality: all ${smaller.length} subset(s) of size < ${mus.length} were checked and are satisfiable`
  );
  return lines.join("\n");
}
