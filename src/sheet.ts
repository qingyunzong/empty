import { Expr, parseFormula, exprToString, normalizeRef } from "./formula";

export type Value =
  | { kind: "num"; value: number }
  | { kind: "error"; code: string; path?: string[] };

export const DIV_ZERO = "#DIV/0!";
export const CYCLE = "#CYCLE!";

export class CycleError extends Error {
  constructor(public readonly path: string[]) {
    super(`circular reference: ${path.join(" -> ")}`);
    this.name = "CycleError";
  }
}

const num = (value: number): Value => ({ kind: "num", value });
const err = (code: string, path?: string[]): Value =>
  path === undefined ? { kind: "error", code } : { kind: "error", code, path };

type Formula = number | Expr;

function evalExpr(expr: Expr, read: (ref: string) => Value): Value {
  switch (expr.type) {
    case "num":
      return num(expr.value);
    case "ref":
      return read(expr.ref);
    case "neg": {
      const v = evalExpr(expr.operand, read);
      return v.kind === "error" ? v : num(-v.value);
    }
    case "bin": {
      const l = evalExpr(expr.left, read);
      if (l.kind === "error") return l;
      const r = evalExpr(expr.right, read);
      if (r.kind === "error") return r;
      const a = l.value;
      const b = r.value;
      switch (expr.op) {
        case "+":
          return num(a + b);
        case "-":
          return num(a - b);
        case "*":
          return num(a * b);
        case "/":
          return b === 0 ? err(DIV_ZERO) : num(Math.trunc(a / b));
        case "=":
          return num(a === b ? 1 : 0);
        case "<>":
          return num(a !== b ? 1 : 0);
        case "<":
          return num(a < b ? 1 : 0);
        case "<=":
          return num(a <= b ? 1 : 0);
        case ">":
          return num(a > b ? 1 : 0);
        case ">=":
          return num(a >= b ? 1 : 0);
      }
    }
    case "if": {
      const cond = evalExpr(expr.cond, read);
      if (cond.kind === "error") return cond;
      // Only the taken branch is evaluated, so only its refs are tracked.
      return evalExpr(cond.value !== 0 ? expr.then : expr.otherwise, read);
    }
  }
}

/**
 * Shared evaluator used both by the live sheet (with dependency tracking and
 * a persistent cache) and by evaluateAll (fresh memo, no tracking).
 */
function evaluateCell(
  formulas: ReadonlyMap<string, Formula>,
  ref: string,
  memo: Map<string, Value>,
  stack: string[],
  onRead?: (dependent: string, dependency: string) => void,
): Value {
  const cached = memo.get(ref);
  if (cached !== undefined) return cached;
  const loopAt = stack.indexOf(ref);
  if (loopAt !== -1) {
    throw new CycleError([...stack.slice(loopAt), ref]);
  }
  stack.push(ref);
  const read = (dep: string): Value => {
    const dependent = stack[stack.length - 1];
    if (onRead && dependent !== undefined) onRead(dependent, dep);
    return evaluateCell(formulas, dep, memo, stack, onRead);
  };
  try {
    const formula = formulas.get(ref);
    let result: Value;
    if (formula === undefined) result = num(0);
    else if (typeof formula === "number") result = num(formula);
    else result = evalExpr(formula, read);
    memo.set(ref, result);
    return result;
  } catch (e) {
    if (e instanceof CycleError) {
      memo.set(ref, err(CYCLE, e.path));
    }
    throw e;
  } finally {
    stack.pop();
  }
}

interface Snapshot {
  formulas: Map<string, Formula>;
  cache: Map<string, Value>;
  deps: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
}

function copyGraph(g: Map<string, Set<string>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [k, v] of g) out.set(k, new Set(v));
  return out;
}

export class Spreadsheet {
  private formulas = new Map<string, Formula>();
  private cache = new Map<string, Value>();
  private deps = new Map<string, Set<string>>(); // cell -> cells it reads
  private dependents = new Map<string, Set<string>>(); // cell -> cells reading it
  private evalStack: string[] = [];
  private snapshots: Snapshot[] = [];

  /** Set a cell to an integer literal or a formula string starting with '='. */
  setCell(ref: string, input: number | string): void {
    const cell = normalizeRef(ref);
    let formula: Formula;
    if (typeof input === "number") {
      formula = Math.trunc(input);
    } else if (input.startsWith("=")) {
      formula = parseFormula(input.slice(1));
    } else {
      throw new Error(`cell input must be an integer or a '=...' formula: ${input}`);
    }
    this.invalidate(cell);
    this.formulas.set(cell, formula);
  }

  /** Remove a cell's formula entirely. */
  clearCell(ref: string): void {
    const cell = normalizeRef(ref);
    this.invalidate(cell);
    this.formulas.delete(cell);
  }

  /** Evaluate a cell, lazily (re)tracking dependencies along the way. */
  getValue(ref: string): Value {
    const cell = normalizeRef(ref);
    try {
      return evaluateCell(this.formulas, cell, this.cache, this.evalStack, this.trackRead);
    } catch (e) {
      if (e instanceof CycleError) {
        return this.cache.get(cell)!;
      }
      throw e;
    }
  }

  /** Cells that `ref` directly reads, given the branches actually executed. */
  getDependencies(ref: string): string[] {
    return [...(this.deps.get(normalizeRef(ref)) ?? [])].sort();
  }

  /** Cells that directly read `ref`. */
  getDependents(ref: string): string[] {
    return [...(this.dependents.get(normalizeRef(ref)) ?? [])].sort();
  }

  /** Original formula text / literal for a cell, or undefined if empty. */
  formulaOf(ref: string): string | number | undefined {
    const f = this.formulas.get(normalizeRef(ref));
    if (f === undefined) return undefined;
    return typeof f === "number" ? f : `=${exprToString(f)}`;
  }

  beginTransaction(): void {
    this.snapshots.push({
      formulas: new Map(this.formulas),
      cache: new Map(this.cache),
      deps: copyGraph(this.deps),
      dependents: copyGraph(this.dependents),
    });
  }

  commit(): void {
    const snap = this.snapshots.pop();
    if (!snap) throw new Error("commit without beginTransaction");
  }

  /** Undo everything since beginTransaction: formulas, values and the dependency graph. */
  rollback(): void {
    const snap = this.snapshots.pop();
    if (!snap) throw new Error("rollback without beginTransaction");
    this.formulas = snap.formulas;
    this.cache = snap.cache;
    this.deps = snap.deps;
    this.dependents = snap.dependents;
  }

  /**
   * Independent full-table evaluation straight from the stored formulas,
   * bypassing the cache and dependency graph. Used to cross-check the
   * incremental engine.
   */
  evaluateAll(): Map<string, Value> {
    const memo = new Map<string, Value>();
    const stack: string[] = [];
    const out = new Map<string, Value>();
    for (const cell of this.formulas.keys()) {
      try {
        out.set(cell, evaluateCell(this.formulas, cell, memo, stack));
      } catch (e) {
        if (e instanceof CycleError) {
          out.set(cell, memo.get(cell)!);
        } else {
          throw e;
        }
      }
    }
    return out;
  }

  private trackRead = (dependent: string, dependency: string): void => {
    let d = this.deps.get(dependent);
    if (!d) this.deps.set(dependent, (d = new Set()));
    d.add(dependency);
    let r = this.dependents.get(dependency);
    if (!r) this.dependents.set(dependency, (r = new Set()));
    r.add(dependent);
  };

  /**
   * Drop the cached value of `cell` and of everything that transitively
   * depends on it, and drop their recorded dependency edges so they are
   * re-tracked from scratch on next evaluation.
   */
  private invalidate(root: string): void {
    const queue = [root];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const cell = queue.pop()!;
      if (seen.has(cell)) continue;
      seen.add(cell);
      this.cache.delete(cell);
      const myDeps = this.deps.get(cell);
      if (myDeps) {
        for (const d of myDeps) this.dependents.get(d)?.delete(cell);
        this.deps.delete(cell);
      }
      const fans = this.dependents.get(cell);
      if (fans) {
        for (const f of fans) queue.push(f);
        this.dependents.delete(cell);
      }
    }
  }
}
