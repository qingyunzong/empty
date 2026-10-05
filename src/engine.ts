import { formatAddr, parseAddr } from './address.js';
import { evalExpr } from './eval.js';
import { parseFormula, staticRefs, type Expr } from './formula.js';
import { CycleError, StaticGraph } from './static-graph.js';
import { errorValue, type Value } from './value.js';

export { CycleError };

/**
 * Incremental spreadsheet engine.
 *
 * - Cell references form a DAG (cycles are rejected at setCell time,
 *   checked against the static reference graph).
 * - Values are integers or errors; errors propagate by minimal origin
 *   address (row-major).
 * - IF only depends on the refs of its condition and its selected branch;
 *   dynamic dependency edges are updated on every recompute.
 * - setCell recomputes only the affected subgraph (the seed cell plus its
 *   static transitive dependents, in topological order).
 */
export class Engine {
  private formulas = new Map<string, Expr>();
  private values = new Map<string, Value>();
  private graph = new StaticGraph();
  private dynDeps = new Map<string, Set<string>>();
  private dynRdeps = new Map<string, Set<string>>();

  /** Current value of a cell, or undefined if the cell is empty. */
  getCell(addrText: string): Value | undefined {
    return this.values.get(formatAddr(parseAddr(addrText)));
  }

  /** Dynamic dependencies of a cell (refs read on the last evaluation). */
  dependenciesOf(addrText: string): string[] {
    const key = formatAddr(parseAddr(addrText));
    return [...(this.dynDeps.get(key) ?? [])].sort();
  }

  /** All formula cells and their values, sorted by address. */
  allValues(): Array<[string, Value]> {
    return [...this.values.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  /**
   * Set or clear (formulaText === null) a cell.
   * Throws CycleError (leaving the table unchanged) if the new formula
   * would close a reference cycle.
   */
  setCell(addrText: string, formulaText: string | null): void {
    const addr = parseAddr(addrText);
    const key = formatAddr(addr);
    if (formulaText === null) {
      this.graph.remove(key);
      this.formulas.delete(key);
      this.values.delete(key);
      this.dropDynEdges(key);
      this.recomputeFrom(key);
      return;
    }
    const expr = parseFormula(formulaText);
    const refs = staticRefs(expr);
    if (this.graph.wouldCycle(key, refs)) {
      throw new CycleError(`formula at ${key} would create a reference cycle`);
    }
    this.graph.set(key, refs);
    this.formulas.set(key, expr);
    this.recomputeFrom(key);
  }

  private dropDynEdges(key: string): void {
    for (const d of this.dynDeps.get(key) ?? []) {
      this.dynRdeps.get(d)?.delete(key);
    }
    this.dynDeps.delete(key);
  }

  private recomputeFrom(seedKey: string): void {
    const affected = this.graph.dependentsClosure(seedKey);
    if (this.formulas.has(seedKey)) affected.add(seedKey);

    // Topological order (Kahn) over the affected subgraph, so every cell is
    // recomputed only after all of its (static, hence also dynamic) deps
    // have settled. Dynamic deps may shrink/switch during recomputation but
    // can never point outside the static graph.
    const indegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    for (const k of affected) {
      let deg = 0;
      for (const d of this.graph.refsOf(k)) {
        if (affected.has(d)) {
          deg++;
          const list = outgoing.get(d) ?? [];
          list.push(k);
          outgoing.set(d, list);
        }
      }
      indegree.set(k, deg);
    }
    const ready = [...affected].filter((k) => indegree.get(k) === 0);
    while (ready.length > 0) {
      const k = ready.pop()!;
      this.evaluate(k);
      for (const next of outgoing.get(k) ?? []) {
        const deg = indegree.get(next)! - 1;
        indegree.set(next, deg);
        if (deg === 0) ready.push(next);
      }
    }
  }

  private evaluate(key: string): void {
    const expr = this.formulas.get(key);
    if (!expr) return;
    const result = evalExpr(expr, parseAddr(key), (refKey, refAddr) => {
      return this.values.get(refKey) ?? errorValue('EMPTY', refAddr);
    });
    this.values.set(key, result.value);

    const oldRefs = this.dynDeps.get(key) ?? new Set<string>();
    for (const d of oldRefs) {
      if (!result.refs.has(d)) this.dynRdeps.get(d)?.delete(key);
    }
    for (const d of result.refs) {
      if (!oldRefs.has(d)) {
        let set = this.dynRdeps.get(d);
        if (!set) {
          set = new Set();
          this.dynRdeps.set(d, set);
        }
        set.add(key);
      }
    }
    this.dynDeps.set(key, result.refs);
  }
}
