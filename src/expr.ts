import { Rational, type RationalInput } from './rational.js';
import { U, triAnd, triFromBoolean, triNot, triOr, type Tri } from './trilean.js';

/** An attribute value is either a boolean or an exact rational. */
export type AttrValue = boolean | Rational;

/** Evaluation environment; a missing key (or undefined) means "unknown". */
export type Attrs = Readonly<Record<string, AttrValue | undefined>>;

export type CmpOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

export type Operand =
  | { kind: 'attr'; name: string }
  | { kind: 'lit'; value: boolean | RationalInput };

export type Expr =
  | { kind: 'cmp'; op: CmpOp; left: Operand; right: Operand }
  | { kind: 'not'; expr: Expr }
  | { kind: 'and'; exprs: readonly Expr[] }
  | { kind: 'or'; exprs: readonly Expr[] };

// Convenience constructors keep policies terse.
export const attr = (name: string): Operand => ({ kind: 'attr', name });
export const lit = (value: boolean | RationalInput): Operand => ({ kind: 'lit', value });
export const cmp = (op: CmpOp, left: Operand, right: Operand): Expr => ({ kind: 'cmp', op, left, right });
export const not = (expr: Expr): Expr => ({ kind: 'not', expr });
export const and = (...exprs: readonly Expr[]): Expr => ({ kind: 'and', exprs });
export const or = (...exprs: readonly Expr[]): Expr => ({ kind: 'or', exprs });

type OperandResult = { known: true; value: AttrValue } | { known: false };

function evalOperand(operand: Operand, attrs: Attrs): OperandResult {
  if (operand.kind === 'attr') {
    const value = attrs[operand.name];
    if (value === undefined) return { known: false };
    return { known: true, value };
  }
  const v = operand.value;
  return { known: true, value: typeof v === 'boolean' ? v : Rational.of(v) };
}

function evalCmp(op: CmpOp, left: Operand, right: Operand, attrs: Attrs): Tri {
  const l = evalOperand(left, attrs);
  const r = evalOperand(right, attrs);
  if (!l.known || !r.known) return U;
  const a = l.value;
  const b = r.value;
  // Mixed types (boolean vs rational) are not comparable -> unknown.
  if (typeof a !== typeof b) return U;
  if (typeof a === 'boolean') {
    // Only equality is defined on booleans; ordering is unknown.
    if (op === 'eq') return triFromBoolean(a === b);
    if (op === 'ne') return triFromBoolean(a !== b);
    return U;
  }
  const c = (a as Rational).compare(b as Rational);
  switch (op) {
    case 'eq': return triFromBoolean(c === 0);
    case 'ne': return triFromBoolean(c !== 0);
    case 'lt': return triFromBoolean(c < 0);
    case 'le': return triFromBoolean(c <= 0);
    case 'gt': return triFromBoolean(c > 0);
    case 'ge': return triFromBoolean(c >= 0);
  }
}

/** Evaluates an expression to a three-valued result under the given attributes. */
export function evalExpr(expr: Expr, attrs: Attrs): Tri {
  switch (expr.kind) {
    case 'cmp':
      return evalCmp(expr.op, expr.left, expr.right, attrs);
    case 'not':
      return triNot(evalExpr(expr.expr, attrs));
    case 'and':
      return triAnd(...expr.exprs.map((e) => evalExpr(e, attrs)));
    case 'or':
      return triOr(...expr.exprs.map((e) => evalExpr(e, attrs)));
  }
}
