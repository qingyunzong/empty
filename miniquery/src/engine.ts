/**
 * Main executor: predicate pushdown, hash join for equi-conditions,
 * hash-based grouping. Cross-checked against the nested-loop reference.
 */

import {
  buildOutput,
  exprAliases,
  feedAccumulators,
  groupKeyOf,
  makeAccumulators,
  planSelect,
  prepare,
  sortOutput,
  splitConjuncts,
  toJsonRows,
  type Prepared,
} from "./common.js";
import { evalPredicate } from "./expr.js";
import type { Expr, Query, Row, TableInput, Value } from "./types.js";
import { groupKey } from "./values.js";

export function runQuery(
  query: Query,
  tables: Record<string, TableInput>,
): Record<string, unknown>[] {
  const p = prepare(query, tables);
  const rows = execute(query, p);
  const plan = planSelect(query, p.resolve);
  const out = aggregateAndProject(plan, rows);
  sortOutput(out);
  return toJsonRows(out);
}

function execute(query: Query, p: Prepared): Row[] {
  const whereConjuncts = query.where ? splitConjuncts(query.where) : [];
  const pending: { expr: Expr; aliases: Set<string> }[] = whereConjuncts.map((expr) => ({
    expr,
    aliases: exprAliases(expr, p.resolve),
  }));

  // Predicate pushdown: single-alias conjuncts filter the base scan.
  const scans = p.sources.map((src) => {
    const applicable = pending.filter((c) => c.aliases.size === 1 && c.aliases.has(src.alias));
    if (applicable.length === 0) return src.rows;
    for (const c of applicable) c.aliases = new Set(); // mark consumed
    return src.rows.filter((row) =>
      applicable.every((c) => evalPredicate(c.expr, row, p.resolve) === true),
    );
  });
  const consumed = (c: { aliases: Set<string> }) => c.aliases.size === 0;

  let leftAliases = new Set([p.sources[0]!.alias]);
  let left: Row[] = scans[0]!;

  for (let i = 0; i < p.joins.length; i++) {
    const rightAlias = p.sources[i + 1]!.alias;
    const right = scans[i + 1]!;
    const onConjuncts = splitConjuncts(p.joins[i]!.on);

    // Equi-join keys: col(left) = col(right) conjuncts.
    const leftKeys: string[] = [];
    const rightKeys: string[] = [];
    const residual: Expr[] = [];
    for (const c of onConjuncts) {
      const pair = equiPair(c, p, leftAliases, rightAlias);
      if (pair) {
        leftKeys.push(pair[0]);
        rightKeys.push(pair[1]);
      } else {
        residual.push(c);
      }
    }

    let joined: Row[];
    if (leftKeys.length > 0) {
      const hash = new Map<string, Row[]>();
      for (const r of right) {
        // NULL keys never match (eq with NULL is UNKNOWN).
        if (rightKeys.some((key) => (r.get(key) ?? null) === null)) continue;
        const k = rightKeys.map((key) => groupKey(r.get(key) ?? null)).join("");
        const bucket = hash.get(k);
        if (bucket) bucket.push(r);
        else hash.set(k, [r]);
      }
      joined = [];
      for (const l of left) {
        if (leftKeys.some((key) => (l.get(key) ?? null) === null)) continue;
        const k = leftKeys.map((key) => groupKey(l.get(key) ?? null)).join("");
        for (const r of hash.get(k) ?? []) joined.push(mergeRows(l, r));
      }
    } else {
      joined = [];
      for (const l of left) for (const r of right) joined.push(mergeRows(l, r));
    }

    const nowAliases = new Set([...leftAliases, rightAlias]);
    const filters: Expr[] = [...residual];
    for (const c of pending) {
      if (consumed(c)) continue;
      if ([...c.aliases].every((a) => nowAliases.has(a))) {
        filters.push(c.expr);
        c.aliases = new Set();
      }
    }
    if (filters.length > 0) {
      joined = joined.filter((row) =>
        filters.every((f) => evalPredicate(f, row, p.resolve) === true),
      );
    }
    left = joined;
    leftAliases = nowAliases;
  }

  const remaining = pending.filter((c) => !consumed(c));
  if (remaining.length > 0) {
    left = left.filter((row) =>
      remaining.every((c) => evalPredicate(c.expr, row, p.resolve) === true),
    );
  }
  return left;
}

function equiPair(
  e: Expr,
  p: Prepared,
  leftAliases: Set<string>,
  rightAlias: string,
): [string, string] | null {
  if (!("op" in e) || e.op !== "eq") return null;
  const [a, b] = e.args;
  if (!("col" in a) || !("col" in b)) return null;
  const ka = p.resolve(a.col);
  const kb = p.resolve(b.col);
  const aliasOf = (k: string) => k.slice(0, k.indexOf("."));
  if (leftAliases.has(aliasOf(ka)) && aliasOf(kb) === rightAlias) return [ka, kb];
  if (leftAliases.has(aliasOf(kb)) && aliasOf(ka) === rightAlias) return [kb, ka];
  return null;
}

function mergeRows(a: Row, b: Row): Row {
  const out: Row = new Map(a);
  for (const [k, v] of b) out.set(k, v);
  return out;
}

function aggregateAndProject(
  plan: ReturnType<typeof planSelect>,
  rows: Row[],
): { names: string[]; values: Value[] }[] {
  if (!plan.aggregate) {
    return rows.map((row) => buildOutput(plan, row, []));
  }
  const groups = new Map<string, { rep: Row; accs: ReturnType<typeof makeAccumulators> }>();
  if (plan.groupKeys.length === 0) {
    // Whole input is a single group, even when empty.
    groups.set("", { rep: rows[0] ?? new Map(), accs: makeAccumulators(plan) });
  }
  for (const row of rows) {
    const k = groupKeyOf(row, plan.groupKeys);
    let g = groups.get(k);
    if (!g) {
      g = { rep: row, accs: makeAccumulators(plan) };
      groups.set(k, g);
    }
    feedAccumulators(plan, g.accs, row);
  }
  return [...groups.values()].map((g) => buildOutput(plan, g.rep, g.accs));
}
