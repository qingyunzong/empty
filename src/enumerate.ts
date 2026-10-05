import { Table } from './table';
import { Value } from './values';

function product<T>(items: T[], n: number): T[][] {
  if (n === 0) return [[]];
  const rest = product(items, n - 1);
  const out: T[][] = [];
  for (const v of items) for (const tail of rest) out.push([v, ...tail]);
  return out;
}

/** 穷举给定模式与值域上、行数不超过 maxRows 的全部表（含重复行）。 */
export function allTables(name: string, schema: string[], domain: Value[], maxRows: number): Table[] {
  const allRows = product(domain, schema.length);
  const tables: Table[] = [];
  for (let n = 0; n <= maxRows; n++) {
    for (const rows of product(allRows, n)) {
      tables.push({ name, schema, rows });
    }
  }
  return tables;
}
