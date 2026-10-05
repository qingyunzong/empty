import { formatAddr } from './address.js';
import { errorValue, intValue, minError } from './value.js';
/**
 * Evaluate an expression. `self` is the address of the cell owning the
 * formula (used as the origin of locally produced errors such as DIV/0).
 * `resolve` returns the current value of a referenced cell.
 *
 * IF is lazy: only the condition and the selected branch are evaluated,
 * so only those refs end up in `refs`.
 */
export function evalExpr(expr, self, resolve) {
    switch (expr.type) {
        case 'num':
            return { value: intValue(expr.value), refs: new Set() };
        case 'ref': {
            const key = formatAddr(expr.addr);
            return { value: resolve(key, expr.addr), refs: new Set([key]) };
        }
        case 'neg': {
            const r = evalExpr(expr.operand, self, resolve);
            if (r.value.kind === 'error')
                return r;
            return { value: intValue(-r.value.value), refs: r.refs };
        }
        case 'bin': {
            const l = evalExpr(expr.left, self, resolve);
            const r = evalExpr(expr.right, self, resolve);
            const refs = new Set([...l.refs, ...r.refs]);
            if (l.value.kind === 'error' || r.value.kind === 'error') {
                return { value: minError(l.value, r.value), refs };
            }
            const a = l.value.value;
            const b = r.value.value;
            switch (expr.op) {
                case '+':
                    return { value: intValue(a + b), refs };
                case '-':
                    return { value: intValue(a - b), refs };
                case '*':
                    return { value: intValue(a * b), refs };
                case '/':
                    if (b === 0)
                        return { value: errorValue('DIV/0', self), refs };
                    return { value: intValue(Math.trunc(a / b)), refs };
                case '=':
                    return { value: intValue(a === b ? 1 : 0), refs };
                case '<>':
                    return { value: intValue(a !== b ? 1 : 0), refs };
                case '<':
                    return { value: intValue(a < b ? 1 : 0), refs };
                case '<=':
                    return { value: intValue(a <= b ? 1 : 0), refs };
                case '>':
                    return { value: intValue(a > b ? 1 : 0), refs };
                case '>=':
                    return { value: intValue(a >= b ? 1 : 0), refs };
            }
            break;
        }
        case 'if': {
            const c = evalExpr(expr.cond, self, resolve);
            if (c.value.kind === 'error')
                return { value: c.value, refs: c.refs };
            const branch = c.value.value !== 0 ? expr.thenBranch : expr.elseBranch;
            const b = evalExpr(branch, self, resolve);
            return { value: b.value, refs: new Set([...c.refs, ...b.refs]) };
        }
    }
}
