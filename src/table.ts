import { Value } from './values';

/** 表：包（bag）语义，允许重复行。 */
export interface Table {
  name: string;
  schema: string[];
  rows: Value[][];
}

export function table(name: string, schema: string[], rows: Value[][]): Table {
  for (const r of rows) {
    if (r.length !== schema.length) throw new Error(`row arity mismatch in ${name}`);
  }
  return { name, schema, rows };
}

const key = (row: Value[]): string => JSON.stringify(row);

/** 多重集合相等：值相同且每个不同行的重复次数相同（顺序无关）。 */
export function multisetEqual(a: Value[][], b: Value[][]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const r of a) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  for (const r of b) {
    const k = key(r);
    const n = counts.get(k);
    if (n === undefined) return false;
    if (n === 1) counts.delete(k);
    else counts.set(k, n - 1);
  }
  return counts.size === 0;
}

/** 规范化打印：排序后的行多重集。 */
export function canonical(rows: Value[][]): string {
  return rows.map(key).sort().join('\n');
}
