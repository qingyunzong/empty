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
export type Expr = {
    kind: 'lit';
    value: boolean;
} | {
    kind: 'var';
    field: string;
} | {
    kind: 'visible';
    field: string;
} | {
    kind: 'not';
    expr: Expr;
} | {
    kind: 'and';
    exprs: readonly Expr[];
} | {
    kind: 'or';
    exprs: readonly Expr[];
};
export declare const lit: (value: boolean) => Expr;
export declare const v: (field: string) => Expr;
export declare const vis: (field: string) => Expr;
export declare const not: (expr: Expr) => Expr;
export declare const and: (...exprs: readonly Expr[]) => Expr;
export declare const or: (...exprs: readonly Expr[]) => Expr;
export interface EvalContext {
    values: Readonly<Record<string, boolean | undefined>>;
    visible: ReadonlySet<string>;
}
export declare function evaluate(expr: Expr, ctx: EvalContext): boolean;
export declare class NonMonotoneConditionError extends Error {
    readonly field: string;
    readonly atomKind: 'var' | 'visible';
    constructor(field: string, atomKind: 'var' | 'visible');
}
/** Rejects any `var`/`visible` atom occurring under an odd number of `not`s. */
export declare function assertMonotone(expr: Expr, negated?: boolean): void;
/** All field names referenced by the expression. */
export declare function referencedFields(expr: Expr, into?: Set<string>): Set<string>;
