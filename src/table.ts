import { Value } from "./values.js";
import { Row } from "./expr.js";

/** A table is a schema plus a MULTISET of rows (duplicates allowed, SQL bag semantics). */
export interface Table {
  schema: string[];
  rows: Row[];
}

export function table(schema: string[], rows: Value[][]): Table {
  return {
    schema: [...schema],
    rows: rows.map((vals) => {
      const r: Row = {};
      schema.forEach((c, i) => { r[c] = vals[i] ?? null; });
      return r;
    }),
  };
}

/** Canonical key for one row over a fixed schema (JSON of values in schema order). */
export function rowKey(schema: readonly string[], r: Row): string {
  return JSON.stringify(schema.map((c) => r[c] ?? null));
}

/**
 * Bag equality: same schema and same row multiplicities, order-insensitive.
 * This is the correctness notion for query equivalence under SQL bag semantics.
 */
export function multisetEqual(
  a: { schema: string[]; rows: Row[] },
  b: { schema: string[]; rows: Row[] },
): boolean {
  if (a.schema.length !== b.schema.length || !a.schema.every((c, i) => c === b.schema[i])) {
    return false;
  }
  if (a.rows.length !== b.rows.length) return false;
  const counts = new Map<string, number>();
  for (const r of a.rows) {
    const k = rowKey(a.schema, r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const r of b.rows) {
    const k = rowKey(a.schema, r);
    const n = counts.get(k);
    if (n === undefined || n === 0) return false;
    counts.set(k, n - 1);
  }
  return true;
}

/** Human-readable diff for failing verifications. */
export function multisetDiff(
  a: { schema: string[]; rows: Row[] },
  b: { schema: string[]; rows: Row[] },
): string {
  const count = (t: { schema: string[]; rows: Row[] }): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of t.rows) {
      const k = rowKey(t.schema, r);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  const lines: string[] = [];
  for (const k of new Set([...ca.keys(), ...cb.keys()])) {
    const na = ca.get(k) ?? 0;
    const nb = cb.get(k) ?? 0;
    if (na !== nb) lines.push(`row ${k}: original x${na} vs rewritten x${nb}`);
  }
  return lines.join("\n");
}
