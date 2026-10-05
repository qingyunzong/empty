import { Tri, FALSE, UNKNOWN, triAnd, triNot, triOf, triOr } from './values';
import { Value } from './values';

export type CmpOp = '=' | '<>' | '<' | '<=' | '>' | '>=';

export type ScalarExpr =
  | { kind: 'col'; name: string }
  | { kind: 'lit'; value: Value };

export type BoolExpr =
  | { kind: 'cmp'; op: CmpOp; left: ScalarExpr; right: ScalarExpr }
  | { kind: 'isNull'; expr: ScalarExpr }
  | { kind: 'and'; args: BoolExpr[] }
  | { kind: 'or'; args: BoolExpr[] }
  | { kind: 'not'; expr: BoolExpr };

// ---- 便于构造的小工具 ----
export const col = (name: string): ScalarExpr => ({ kind: 'col', name });
export const lit = (value: Value): ScalarExpr => ({ kind: 'lit', value });
export const cmp = (op: CmpOp, left: ScalarExpr, right: ScalarExpr): BoolExpr => ({ kind: 'cmp', op, left, right });
export const eq = (l: ScalarExpr, r: ScalarExpr): BoolExpr => cmp('=', l, r);
export const isNull = (e: ScalarExpr): BoolExpr => ({ kind: 'isNull', expr: e });
export const notNull = (e: ScalarExpr): BoolExpr => ({ kind: 'not', expr: isNull(e) });
export const and = (...args: BoolExpr[]): BoolExpr => ({ kind: 'and', args });
export const or = (...args: BoolExpr[]): BoolExpr => ({ kind: 'or', args });
export const not = (e: BoolExpr): BoolExpr => ({ kind: 'not', expr: e });

// ---- 求值（三值逻辑）----
export function evalScalar(e: ScalarExpr, row: Value[], schema: string[]): Value {
  if (e.kind === 'lit') return e.value;
  const i = schema.indexOf(e.name);
  if (i < 0) throw new Error(`unknown column: ${e.name}`);
  return row[i] ?? null;
}

function compare(op: CmpOp, a: Value, b: Value): Tri {
  if (a === null || b === null) return UNKNOWN; // NULL 参与比较 => UNKNOWN
  if (typeof a !== typeof b) return FALSE;
  switch (op) {
    case '=': return triOf(a === b);
    case '<>': return triOf(a !== b);
    case '<': return triOf(a < b);
    case '<=': return triOf(a <= b);
    case '>': return triOf(a > b);
    case '>=': return triOf(a >= b);
  }
}

export function evalBool(e: BoolExpr, row: Value[], schema: string[]): Tri {
  switch (e.kind) {
    case 'cmp':
      return compare(e.op, evalScalar(e.left, row, schema), evalScalar(e.right, row, schema));
    case 'isNull':
      return triOf(evalScalar(e.expr, row, schema) === null);
    case 'and': {
      let acc: Tri = 2 as Tri;
      for (const a of e.args) acc = triAnd(acc, evalBool(a, row, schema));
      return acc;
    }
    case 'or': {
      let acc: Tri = FALSE;
      for (const a of e.args) acc = triOr(acc, evalBool(a, row, schema));
      return acc;
    }
    case 'not':
      return triNot(evalBool(e.expr, row, schema));
  }
}

// ---- 列引用分析 ----
export function scalarCols(e: ScalarExpr): string[] {
  return e.kind === 'col' ? [e.name] : [];
}

export function boolCols(e: BoolExpr): string[] {
  switch (e.kind) {
    case 'cmp': return [...scalarCols(e.left), ...scalarCols(e.right)];
    case 'isNull': return scalarCols(e.expr);
    case 'and':
    case 'or': return e.args.flatMap(boolCols);
    case 'not': return boolCols(e.expr);
  }
}

export function uniqueCols(e: BoolExpr): string[] {
  return [...new Set(boolCols(e))];
}

/**
 * 公开的（语法可判定）“拒绝 NULL”判定：
 * 当 cols 中所有列都为 NULL 时，该谓词保证不为 TRUE（即为 FALSE 或 UNKNOWN）。
 * 这是外连接转内连接规则的充分前置条件；判定是保守的（可能漏判，绝不误判）。
 */
export function isNullRejecting(e: BoolExpr, cols: ReadonlySet<string>): boolean {
  switch (e.kind) {
    case 'cmp': {
      // 比较涉及 nullable 侧列 => 该列为 NULL 时比较结果为 UNKNOWN（非 TRUE）
      const hits = [...scalarCols(e.left), ...scalarCols(e.right)].some((c) => cols.has(c));
      return hits;
    }
    case 'isNull':
      return false; // IS NULL 在列为 NULL 时为 TRUE，恰是“接受 NULL”
    case 'and':
      // 合取中任一分支永不为 TRUE，则整体永不为 TRUE
      return e.args.some((a) => isNullRejecting(a, cols));
    case 'or':
      // 析取需所有分支都永不为 TRUE
      return e.args.every((a) => isNullRejecting(a, cols));
    case 'not':
      // NOT(IS NULL c) 在 c 为 NULL 时为 FALSE
      return e.expr.kind === 'isNull' && scalarCols(e.expr.expr).some((c) => cols.has(c));
  }
}

// ---- 渲染（用于证书）----
export function renderScalar(e: ScalarExpr): string {
  if (e.kind === 'col') return e.name;
  return e.value === null ? 'NULL' : JSON.stringify(e.value);
}

export function renderBool(e: BoolExpr): string {
  switch (e.kind) {
    case 'cmp': return `${renderScalar(e.left)} ${e.op} ${renderScalar(e.right)}`;
    case 'isNull': return `${renderScalar(e.expr)} IS NULL`;
    case 'and': return `(${e.args.map(renderBool).join(' AND ')})`;
    case 'or': return `(${e.args.map(renderBool).join(' OR ')})`;
    case 'not': return `(NOT ${renderBool(e.expr)})`;
  }
}

/** 把谓词拆成合取项列表。 */
export function conjuncts(e: BoolExpr): BoolExpr[] {
  return e.kind === 'and' ? e.args.flatMap(conjuncts) : [e];
}

/** 由合取项列表重建谓词（空列表 => 永真，用 1=1 表示）。 */
export function conjoin(items: BoolExpr[]): BoolExpr {
  if (items.length === 0) return eq(lit(1), lit(1));
  if (items.length === 1) return items[0]!;
  return { kind: 'and', args: items };
}
