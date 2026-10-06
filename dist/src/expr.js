export const lit = (value) => ({ kind: 'lit', value });
export const v = (field) => ({ kind: 'var', field });
export const vis = (field) => ({ kind: 'visible', field });
export const not = (expr) => ({ kind: 'not', expr });
export const and = (...exprs) => ({ kind: 'and', exprs });
export const or = (...exprs) => ({ kind: 'or', exprs });
export function evaluate(expr, ctx) {
    switch (expr.kind) {
        case 'lit':
            return expr.value;
        case 'var':
            // Hidden fields are treated as unfilled; unfilled reads as false.
            if (!ctx.visible.has(expr.field))
                return false;
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
    field;
    atomKind;
    constructor(field, atomKind) {
        super(`Non-monotone hidden reference: "${field}" (${atomKind}) appears under ` +
            `a negation. Conditions must be monotone in the visible set so the ` +
            `least fixed point from the all-hidden state is well-defined.`);
        this.field = field;
        this.atomKind = atomKind;
        this.name = 'NonMonotoneConditionError';
    }
}
/** Rejects any `var`/`visible` atom occurring under an odd number of `not`s. */
export function assertMonotone(expr, negated = false) {
    switch (expr.kind) {
        case 'lit':
            return;
        case 'var':
        case 'visible':
            if (negated)
                throw new NonMonotoneConditionError(expr.field, expr.kind);
            return;
        case 'not':
            assertMonotone(expr.expr, !negated);
            return;
        case 'and':
        case 'or':
            for (const e of expr.exprs)
                assertMonotone(e, negated);
            return;
    }
}
/** All field names referenced by the expression. */
export function referencedFields(expr, into = new Set()) {
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
            for (const e of expr.exprs)
                referencedFields(e, into);
            return into;
    }
}
