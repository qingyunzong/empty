import { formatAddr, parseAddr } from './address.js';
import { evalExpr } from './eval.js';
import { parseFormula, staticRefs } from './formula.js';
import { CycleError, StaticGraph } from './static-graph.js';
import { errorValue } from './value.js';
export { CycleError };
/**
 * Naive oracle: stores formulas and, on demand, re-evaluates the whole
 * table from scratch with plain recursion + memoization. Used as the
 * reference implementation in differential tests against Engine.
 */
export class Interpreter {
    formulas = new Map();
    graph = new StaticGraph();
    setCell(addrText, formulaText) {
        const addr = parseAddr(addrText);
        const key = formatAddr(addr);
        if (formulaText === null) {
            this.graph.remove(key);
            this.formulas.delete(key);
            return;
        }
        const expr = parseFormula(formulaText);
        const refs = staticRefs(expr);
        if (this.graph.wouldCycle(key, refs)) {
            throw new CycleError(`formula at ${key} would create a reference cycle`);
        }
        this.graph.set(key, refs);
        this.formulas.set(key, expr);
    }
    /** Recompute every cell from scratch. */
    evaluateAll() {
        const memo = new Map();
        const visiting = new Set();
        const evalCell = (key) => {
            const cached = memo.get(key);
            if (cached)
                return cached;
            const expr = this.formulas.get(key);
            if (!expr)
                return errorValue('EMPTY', parseAddr(key));
            if (visiting.has(key))
                throw new Error(`unexpected cycle at ${key}`);
            visiting.add(key);
            const result = evalExpr(expr, parseAddr(key), (refKey) => evalCell(refKey));
            visiting.delete(key);
            memo.set(key, result.value);
            return result.value;
        };
        for (const key of this.formulas.keys())
            evalCell(key);
        return memo;
    }
}
