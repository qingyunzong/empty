import { formatAddr, parseAddr } from './address.js';
import { evalExpr } from './eval.js';
import { parseFormula, staticRefs, type Expr } from './formula.js';
import { CycleError, StaticGraph } from './static-graph.js';
import { errorValue, type Value } from './value.js';

export { CycleError };

/**
 * Naive oracle: stores formulas and, on demand, re-evaluates the whole
 * table from scratch with plain recursion + memoization. Used as the
 * reference implementation in differential tests against Engine.
 */
export class Interpreter {
  private formulas = new Map<string, Expr>();
  private graph = new StaticGraph();

  setCell(addrText: string, formulaText: string | null): void {
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
  evaluateAll(): Map<string, Value> {
    const memo = new Map<string, Value>();
    const visiting = new Set<string>();

    const evalCell = (key: string): Value => {
      const cached = memo.get(key);
      if (cached) return cached;
      const expr = this.formulas.get(key);
      if (!expr) return errorValue('EMPTY', parseAddr(key));
      if (visiting.has(key)) throw new Error(`unexpected cycle at ${key}`);
      visiting.add(key);
      const result = evalExpr(expr, parseAddr(key), (refKey) => evalCell(refKey));
      visiting.delete(key);
      memo.set(key, result.value);
      return result.value;
    };

    for (const key of this.formulas.keys()) evalCell(key);
    return memo;
  }
}
