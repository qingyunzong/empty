/**
 * Boolean expressions over field values and field visibility.
 *
 * Semantics:
 * - `var(f)` reads the value of field `f`. A hidden field is treated as
 *   unfilled, and an unfilled boolean reads as `false`.
 * - `visible(f)` tests whether field `f` is currently visible.
 *
 * Monotonicity:
 * Visibility is computed as a least fixed point reached by iterating from
 * the all-hidden state, so every condition must be monotone in the visible
 * set. Both `var` and `visible` atoms depend on the visible set, therefore
 * neither may appear under a `not`. `assertMonotone` rejects such
 * non-monotone hidden references.
 */
export type Expr =
  | { kind: 'lit'; value: boolean }
  | { kind: 'var'; field: string }
  | { kind: 'visible'; field: string }
  | { kind: 'not'; expr: Expr }
  | { kind: 'and'; exprs: readonly Expr[] }
  | { kind: 'or'; exprs: readonly Expr[] };

export const lit = (value: boolean): Expr => ({ kind: 'lit', value });
export const v = (field: string): Expr => ({ kind: 'var', field });
export const vis = (field: string): Expr => ({ kind: 'visible', field });
export const not = (expr: Expr): Expr => ({ kind: 'not', expr });
export const and = (...exprs: readonly Expr[]): Expr => ({ kind: 'and', exprs });
export const or = (...exprs: readonly Expr[]): Expr => ({ kind: 'or', exprs });

export interface EvalContext {
  values: Readonly<Record<string, boolean | undefined>>;
  visible: ReadonlySet<string>;
}

export function evaluate(expr: Expr, ctx: EvalContext): boolean {
  switch (expr.kind) {
    case 'lit':
      return expr.value;
    case 'var':
      // Hidden fields are treated as unfilled; unfilled reads as false.
      if (!ctx.visible.has(expr.field)) return false;
      return ctx.values[expr.field] ?? false;
    case 'visible':
      return ctx.visible.has(expr.field);
    case 'not':
      return !evaluate(expr.expr, ctx);
    case 'and':
      return expr.exprs.every((e) => evaluate(e, ctx));
    case 'or':
      return expr.exprs.some((e) => evaluate(e, ctx));
  }
}

export class NonMonotoneConditionError extends Error {
  constructor(
    public readonly field: string,
    public readonly atomKind: 'var' | 'visible',
  ) {
    super(
      `Non-monotone hidden reference: "${field}" (${atomKind}) appears under ` +
        `a negation. Conditions must be monotone in the visible set so the ` +
        `least fixed point from the all-hidden state is well-defined.`,
    );
    this.name = 'NonMonotoneConditionError';
  }
}

/** Rejects any `var`/`visible` atom occurring under an odd number of `not`s. */
export function assertMonotone(expr: Expr, negated = false): void {
  switch (expr.kind) {
    case 'lit':
      return;
    case 'var':
    case 'visible':
      if (negated) throw new NonMonotoneConditionError(expr.field, expr.kind);
      return;
    case 'not':
      assertMonotone(expr.expr, !negated);
      return;
    case 'and':
    case 'or':
      for (const e of expr.exprs) assertMonotone(e, negated);
      return;
  }
}

/** All field names referenced by the expression. */
export function referencedFields(expr: Expr, into = new Set<string>()): Set<string> {
  switch (expr.kind) {
    case 'lit':
      return into;
    case 'var':
    case 'visible':
      into.add(expr.field);
      return into;
    case 'not':
      return referencedFields(expr.expr, into);
    case 'and':
    case 'or':
      for (const e of expr.exprs) referencedFields(e, into);
      return into;
  }
}
