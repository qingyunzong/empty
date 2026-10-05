import { Expr, Stmt } from './ast';
import { BudgetExhaustedError, ScriptRuntimeError } from './errors';
import { parse } from './parser';

export type Value = number | string | Value[] | Dict;
export type Dict = Map<string, Value>;

export interface InterpreterOptions {
  /** Maximum number of charged steps before BudgetExhaustedError. Default 100_000. */
  budget?: number;
  /** Maximum parser nesting depth. Default 200. */
  maxDepth?: number;
}

export const DEFAULT_BUDGET = 100_000;

class BreakSignal extends Error { }
class ContinueSignal extends Error { }
class RollbackSignal extends Error { }

function typeName(v: Value): string {
  if (typeof v === 'number') return 'int';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

function truthy(v: Value): boolean {
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return v.size > 0;
}

function deepEqual(a: Value, b: Value): boolean {
  if (typeof a === 'number' || typeof a === 'string') return a === b;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k) as Value)) return false;
    }
    return true;
  }
  return false;
}

/** Deep-freeze-free deep clone used when snapshots are handed out. */
function deepClone(v: Value): Value {
  if (Array.isArray(v)) return v.map(deepClone);
  if (v instanceof Map) {
    const out: Dict = new Map();
    for (const [k, x] of v) out.set(k, deepClone(x));
    return out;
  }
  return v;
}

/** Convert a Value to plain JS data (Maps become objects) for assertions/printing. */
export function toJS(v: Value): unknown {
  if (Array.isArray(v)) return v.map(toJS);
  if (v instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of v) out[k] = toJS(x);
    return out;
  }
  return v;
}

export class Interpreter {
  private readonly globals: Dict = new Map();
  private readonly txStack: Dict[] = [];
  private budget: number;
  private readonly maxDepth?: number;
  private steps = 0;

  constructor(options: InterpreterOptions = {}) {
    this.budget = options.budget ?? DEFAULT_BUDGET;
    this.maxDepth = options.maxDepth;
  }

  get stepsUsed(): number { return this.steps; }

  get stepBudget(): number { return this.budget; }

  /** Grant additional step budget, e.g. to inspect or continue after exhaustion. */
  refuel(additionalSteps: number): void {
    this.budget += additionalSteps;
  }

  /** Number of transaction frames still open (unclosed state survives budget exhaustion). */
  get txDepth(): number { return this.txStack.length; }

  /** Snapshot of the writes still pending inside each unclosed transaction, innermost last. */
  pendingWrites(): Array<Map<string, Value>> {
    return this.txStack.map((frame) => {
      const snap: Map<string, Value> = new Map();
      for (const [k, v] of frame) snap.set(k, deepClone(v));
      return snap;
    });
  }

  /** Discard all unclosed transaction frames without publishing their writes. */
  abortUnclosed(): void {
    this.txStack.length = 0;
  }

  /** Read a variable from the published store. Uncommitted transaction writes are not visible here. */
  get(name: string): Value | undefined {
    const v = this.globals.get(name);
    return v === undefined ? undefined : deepClone(v);
  }

  /** Read a variable as the running script would see it, including uncommitted transaction writes. */
  getVisible(name: string): Value | undefined {
    const v = this.lookup(name);
    return v === undefined ? undefined : deepClone(v);
  }

  /** Names currently published in the global store. */
  globalNames(): string[] {
    return [...this.globals.keys()];
  }

  /** Parse and run a program. Returns the value of the last expression statement, if any. */
  run(source: string): Value | undefined {
    const program = parse(source, this.maxDepth);
    let last: Value | undefined;
    for (const stmt of program) {
      const v = this.execStmt(stmt);
      if (v !== undefined) last = v;
    }
    return last;
  }

  private charge(): void {
    if (this.steps >= this.budget) {
      throw new BudgetExhaustedError(this.steps, this.budget);
    }
    this.steps++;
  }

  private lookup(name: string): Value | undefined {
    for (let i = this.txStack.length - 1; i >= 0; i--) {
      const frame = this.txStack[i];
      if (frame.has(name)) return frame.get(name);
    }
    return this.globals.get(name);
  }

  private has(name: string): boolean {
    return this.lookup(name) !== undefined;
  }

  /** Write a variable: into the innermost open transaction if any, else the global store. */
  private store(name: string, value: Value): void {
    const target = this.txStack.length > 0 ? this.txStack[this.txStack.length - 1] : this.globals;
    target.set(name, value);
  }

  private execStmt(stmt: Stmt): Value | undefined {
    switch (stmt.kind) {
      case 'let': {
        const value = this.evalExpr(stmt.value);
        this.store(stmt.name, value);
        return undefined;
      }
      case 'assign':
        this.execAssign(stmt.target, stmt.value);
        return undefined;
      case 'if':
        return this.execBlock(truthy(this.evalExpr(stmt.cond)) ? stmt.then : stmt.else);
      case 'while': {
        let last: Value | undefined;
        for (;;) {
          this.charge(); // loop back-edge
          if (!truthy(this.evalExpr(stmt.cond))) break;
          try {
            const v = this.execBlock(stmt.body);
            if (v !== undefined) last = v;
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return last;
      }
      case 'transaction':
        return this.execTransaction(stmt.body);
      case 'rollback':
        if (this.txStack.length === 0) throw new ScriptRuntimeError('rollback outside transaction');
        throw new RollbackSignal();
      case 'break':
        throw new BreakSignal();
      case 'continue':
        throw new ContinueSignal();
      case 'expr':
        return this.evalExpr(stmt.expr);
    }
  }

  private execBlock(stmts: Stmt[]): Value | undefined {
    let last: Value | undefined;
    for (const stmt of stmts) {
      const v = this.execStmt(stmt);
      if (v !== undefined) last = v;
    }
    return last;
  }

  private execTransaction(body: Stmt[]): Value | undefined {
    const frame: Dict = new Map();
    this.txStack.push(frame);
    try {
      const result = this.execBlock(body);
      // Normal exit: publish writes to the parent frame or the global store.
      this.txStack.pop();
      const parent = this.txStack.length > 0 ? this.txStack[this.txStack.length - 1] : this.globals;
      for (const [k, v] of frame) parent.set(k, v);
      return result;
    } catch (e) {
      if (e instanceof BudgetExhaustedError) {
        // Budget exhaustion preserves unclosed state: the frame stays on the
        // stack, unmerged, so no partial writes reach the published store.
        throw e;
      }
      // Rollback statement or runtime error: discard this frame's writes.
      this.txStack.pop();
      if (e instanceof RollbackSignal) return undefined;
      throw e;
    }
  }

  private execAssign(target: Expr, valueExpr: Expr): void {
    // Collect the l-value path: base variable plus index keys.
    const indices: Expr[] = [];
    let cur: Expr = target;
    while (cur.kind === 'index') {
      indices.unshift(cur.index);
      cur = cur.target;
    }
    if (cur.kind !== 'var') throw new ScriptRuntimeError('invalid assignment target');
    const name = cur.name;
    if (!this.has(name)) throw new ScriptRuntimeError(`assignment to undefined variable '${name}'`);

    if (indices.length === 0) {
      this.store(name, this.evalExpr(valueExpr));
      return;
    }

    const keys: Value[] = indices.map((e) => this.evalExpr(e));
    const value = this.evalExpr(valueExpr);
    const root = this.lookup(name) as Value;
    this.store(name, this.copySet(root, keys, value));
  }

  /**
   * Persistent update: returns a new container with keys[0]...[keys[n-1]] set
   * to value. The original is never mutated, so earlier aliases (and the
   * published store, until commit) can never observe partial writes.
   */
  private copySet(container: Value, keys: Value[], value: Value): Value {
    if (keys.length === 0) return value;
    const [key, ...rest] = keys;
    if (Array.isArray(container)) {
      if (typeof key !== 'number') {
        throw new ScriptRuntimeError(`list index must be int, got ${typeName(key)}`);
      }
      if (!Number.isInteger(key) || key < 0 || key >= container.length) {
        throw new ScriptRuntimeError(`list index ${key} out of range (length ${container.length})`);
      }
      const copy = container.slice();
      copy[key] = this.copySet(container[key], rest, value);
      return copy;
    }
    if (container instanceof Map) {
      if (typeof key !== 'string') {
        throw new ScriptRuntimeError(`dict key must be string, got ${typeName(key)}`);
      }
      if (!container.has(key) && rest.length > 0) {
        throw new ScriptRuntimeError(`dict has no key '${key}' to index into`);
      }
      const copy: Dict = new Map(container);
      copy.set(key, this.copySet(container.get(key) as Value, rest, value));
      return copy;
    }
    throw new ScriptRuntimeError(`cannot index into ${typeName(container)}`);
  }

  private evalExpr(expr: Expr): Value {
    this.charge(); // every evaluation counts against the budget
    switch (expr.kind) {
      case 'int': return expr.value;
      case 'str': return expr.value;
      case 'var': {
        const v = this.lookup(expr.name);
        if (v === undefined) throw new ScriptRuntimeError(`undefined variable '${expr.name}'`);
        return v;
      }
      case 'list': return expr.items.map((item) => this.evalExpr(item));
      case 'dict': {
        const out: Dict = new Map();
        for (const { key, value } of expr.entries) out.set(key, this.evalExpr(value));
        return out;
      }
      case 'index': {
        const target = this.evalExpr(expr.target);
        const index = this.evalExpr(expr.index);
        if (Array.isArray(target)) {
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= target.length) {
            throw new ScriptRuntimeError(`list index out of range`);
          }
          return target[index];
        }
        if (target instanceof Map) {
          if (typeof index !== 'string') {
            throw new ScriptRuntimeError(`dict key must be string, got ${typeName(index)}`);
          }
          if (!target.has(index)) throw new ScriptRuntimeError(`dict has no key '${index}'`);
          return target.get(index) as Value;
        }
        throw new ScriptRuntimeError(`cannot index into ${typeName(target)}`);
      }
      case 'unary': {
        const v = this.evalExpr(expr.operand);
        if (expr.op === '!') return truthy(v) ? 0 : 1;
        if (typeof v !== 'number') throw new ScriptRuntimeError(`unary - needs int, got ${typeName(v)}`);
        return this.checkedInt(-v);
      }
      case 'binary': return this.evalBinary(expr);
    }
  }

  private evalBinary(expr: Extract<Expr, { kind: 'binary' }>): Value {
    const op = expr.op;
    if (op === '&&') {
      const l = this.evalExpr(expr.left);
      if (!truthy(l)) return 0;
      return truthy(this.evalExpr(expr.right)) ? 1 : 0;
    }
    if (op === '||') {
      const l = this.evalExpr(expr.left);
      if (truthy(l)) return 1;
      return truthy(this.evalExpr(expr.right)) ? 1 : 0;
    }
    const l = this.evalExpr(expr.left);
    const r = this.evalExpr(expr.right);
    switch (op) {
      case '+':
        if (typeof l === 'number' && typeof r === 'number') return this.checkedInt(l + r);
        if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
        throw new ScriptRuntimeError(`cannot add ${typeName(l)} and ${typeName(r)}`);
      case '-': return this.checkedInt(this.needInt(l, op) - this.needInt(r, op));
      case '*': return this.checkedInt(this.needInt(l, op) * this.needInt(r, op));
      case '/': {
        const a = this.needInt(l, op); const b = this.needInt(r, op);
        if (b === 0) throw new ScriptRuntimeError('division by zero');
        return this.checkedInt(Math.trunc(a / b));
      }
      case '%': {
        const a = this.needInt(l, op); const b = this.needInt(r, op);
        if (b === 0) throw new ScriptRuntimeError('modulo by zero');
        return a % b;
      }
      case '==': return deepEqual(l, r) ? 1 : 0;
      case '!=': return deepEqual(l, r) ? 0 : 1;
      case '<': return this.needInt(l, op) < this.needInt(r, op) ? 1 : 0;
      case '<=': return this.needInt(l, op) <= this.needInt(r, op) ? 1 : 0;
      case '>': return this.needInt(l, op) > this.needInt(r, op) ? 1 : 0;
      case '>=': return this.needInt(l, op) >= this.needInt(r, op) ? 1 : 0;
    }
  }

  private needInt(v: Value, op: string): number {
    if (typeof v !== 'number') throw new ScriptRuntimeError(`operator '${op}' needs int, got ${typeName(v)}`);
    return v;
  }

  private checkedInt(n: number): number {
    if (!Number.isSafeInteger(n)) throw new ScriptRuntimeError('integer overflow');
    return n;
  }
}
