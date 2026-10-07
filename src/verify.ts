import { Value } from "./values.js";
import { Row } from "./expr.js";
import { Table, multisetEqual, multisetDiff } from "./table.js";
import { Plan, execute } from "./plan.js";

/**
 * Exhaustive small-table equivalence checker.
 *
 * A plan template is a function building a Plan from concrete tables. The
 * checker enumerates EVERY combination of small tables (all multisets of up
 * to `maxRows` rows drawn from `domain`^arity), executes the original and
 * the rewritten template on each combination, and demands bag equality of
 * results — values AND duplicate multiplicities.
 */
export interface TableSpec {
  name: string;
  arity: number;
}

export interface VerifyOptions {
  domain?: Value[];
  maxRows?: number;
}

export interface VerifyResult {
  ok: boolean;
  combinationsChecked: number;
  counterexample?: { tables: Record<string, Table>; diff: string };
}

/** All multisets of rows of size 0..maxRows over domain^arity. */
export function enumerateTables(arity: number, domain: Value[], maxRows: number): Table[] {
  const tuples: Value[][] = [[]];
  for (let i = 0; i < arity; i++) {
    const prev = tuples.splice(0);
    for (const t of prev) for (const d of domain) tuples.push([...t, d]);
  }
  const schema = Array.from({ length: arity }, (_, i) => `c${i}`);
  const out: Table[] = [];
  // Multisets of size k = combinations with repetition of tuples.
  const choose = (start: number, k: number, acc: Value[][]): void => {
    if (k === 0) {
      out.push({
        schema,
        rows: acc.map((vals) => {
          const r: Row = {};
          schema.forEach((c, i) => { r[c] = vals[i] ?? null; });
          return r;
        }),
      });
      return;
    }
    for (let i = start; i < tuples.length; i++) {
      choose(i, k - 1, [...acc, tuples[i]!]);
    }
  };
  for (let k = 0; k <= maxRows; k++) choose(0, k, []);
  return out;
}

function* product<T>(lists: T[][]): Generator<T[]> {
  if (lists.length === 0) { yield []; return; }
  const [head, ...rest] = lists;
  for (const x of head!) for (const tail of product(rest)) yield [x, ...tail];
}

/** Verify `original(tables)` ≡ `rewritten(tables)` over the exhaustive small-table space. */
export function verifyEquivalence(
  specs: TableSpec[],
  original: (tables: Record<string, Table>) => Plan,
  rewritten: (tables: Record<string, Table>) => Plan,
  opts: VerifyOptions = {},
): VerifyResult {
  const domain = opts.domain ?? [null, 0, 1];
  const maxRows = opts.maxRows ?? 2;
  const spaces = specs.map((s) => enumerateTables(s.arity, domain, maxRows));
  let checked = 0;
  for (const combo of product(spaces)) {
    const tables: Record<string, Table> = {};
    specs.forEach((s, i) => {
      // Rename columns to the spec's canonical names c0..c{arity-1} prefixed per table
      // so cross-table column names are globally unique (plan assumption).
      const t = combo[i]!;
      tables[s.name] = {
        schema: t.schema.map((c) => `${s.name}.${c}`),
        rows: t.rows.map((r) => {
          const nr: Row = {};
          t.schema.forEach((c, j) => { nr[`${s.name}.${c}`] = r[c] ?? null; });
          return nr;
        }),
      };
    });
    checked++;
    const a = execute(original(tables));
    const b = execute(rewritten(tables));
    if (!multisetEqual(a, b)) {
      return { ok: false, combinationsChecked: checked, counterexample: { tables, diff: multisetDiff(a, b) } };
    }
  }
  return { ok: true, combinationsChecked: checked };
}
