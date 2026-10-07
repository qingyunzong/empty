import type { Expr, Program, Stmt } from './ast.js';
import { BudgetExhausted, ScriptError, makeDict, type Dict, type Value } from './values.js';

class ReturnSignal {
  constructor(public readonly value: Value) {}
}

interface Scope {
  vars: Map<string, Value>;
  parent: Scope | null;
}

function lookup(scope: Scope, name: string): Value {
  for (let s: Scope | null = scope; s; s = s.parent) {
    if (s.vars.has(name)) return s.vars.get(name)!;
  }
  throw new ScriptError(`undefined variable '${name}'`);
}

function assign(scope: Scope, name: string, value: Value): void {
  for (let s: Scope | null = scope; s; s = s.parent) {
    if (s.vars.has(name)) {
      s.vars.set(name, value);
      return;
    }
  }
  throw new ScriptError(`assignment to undefined variable '${name}'`);
}

function truthy(v: Value): boolean {
  if (v === null || v === false) return false;
  if (v === 0 || v === '') return false;
  return true;
}

function valuesEqual(a: Value, b: Value): boolean {
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]!));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length
      && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k)
        && valuesEqual((a as Dict)[k]!, (b as Dict)[k]!));
  }
  return a === b;
}

export class Interpreter {
  private stepsLeft: number;
  private stepsUsedCount = 0;
  /** Buffered transactional writes; published only on normal exit. */
  readonly pendingWrites = new Map<string, Value>();

  constructor(budget: number) {
    if (!Number.isInteger(budget) || budget < 0) {
      throw new ScriptError('budget must be a non-negative integer');
    }
    this.stepsLeft = budget;
  }

  get stepsUsed(): number {
    return this.stepsUsedCount;
  }

  /** Every evaluation step and every loop back-edge pays one step. */
  private step(): void {
    this.stepsUsedCount++;
    if (--this.stepsLeft < 0) throw new BudgetExhausted(this.stepsUsedCount - 1);
  }

  run(program: Program): Value {
    const scope: Scope = { vars: new Map(), parent: null };
    try {
      this.execBlock(program.stmts, scope);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    return null;
  }

  private execBlock(stmts: Stmt[], parent: Scope): void {
    const scope: Scope = { vars: new Map(), parent };
    for (const stmt of stmts) this.execStmt(stmt, scope);
  }

  private execStmt(stmt: Stmt, scope: Scope): void {
    this.step();
    switch (stmt.tag) {
      case 'let':
        scope.vars.set(stmt.name, this.evalExpr(stmt.init, scope));
        return;
      case 'assign':
        assign(scope, stmt.name, this.evalExpr(stmt.value, scope));
        return;
      case 'expr':
        this.evalExpr(stmt.expr, scope);
        return;
      case 'while':
        while (truthy(this.evalExpr(stmt.cond, scope))) {
          this.execBlock(stmt.body, scope);
          this.step(); // loop back-edge
        }
        return;
      case 'if':
        if (truthy(this.evalExpr(stmt.cond, scope))) this.execBlock(stmt.then, scope);
        else if (stmt.else.length > 0) this.execBlock(stmt.else, scope);
        return;
      case 'set': {
        const key = this.evalExpr(stmt.key, scope);
        if (typeof key !== 'string') {
          throw new ScriptError('set() key must be a string');
        }
        this.pendingWrites.set(key, this.evalExpr(stmt.value, scope));
        return;
      }
      case 'return':
        throw new ReturnSignal(this.evalExpr(stmt.value, scope));
    }
  }

  private evalExpr(expr: Expr, scope: Scope): Value {
    this.step();
    switch (expr.tag) {
      case 'num':
      case 'str':
        return expr.value;
      case 'bool':
        return expr.value;
      case 'null':
        return null;
      case 'var':
        return lookup(scope, expr.name);
      case 'list':
        return expr.items.map((item) => this.evalExpr(item, scope));
      case 'dict': {
        const out = makeDict();
        for (const { key, value } of expr.entries) {
          out[key] = this.evalExpr(value, scope);
        }
        return out;
      }
      case 'index': {
        const target = this.evalExpr(expr.target, scope);
        const key = this.evalExpr(expr.key, scope);
        if (Array.isArray(target)) {
          if (typeof key !== 'number' || !Number.isInteger(key)) {
            throw new ScriptError('list index must be an integer');
          }
          if (key < 0 || key >= target.length) {
            throw new ScriptError(`list index ${key} out of range`);
          }
          return target[key]!;
        }
        if (target !== null && typeof target === 'object') {
          if (typeof key !== 'string') throw new ScriptError('dict key must be a string');
          // Own-property check only: prototype chain is never consulted.
          if (!Object.prototype.hasOwnProperty.call(target, key)) {
            throw new ScriptError(`no such key '${key}'`);
          }
          return (target as Dict)[key]!;
        }
        throw new ScriptError('cannot index a non-list/non-dict value');
      }
      case 'len': {
        const v = this.evalExpr(expr.arg, scope);
        if (typeof v === 'string' || Array.isArray(v)) return v.length;
        if (v !== null && typeof v === 'object') return Object.keys(v).length;
        throw new ScriptError('len() expects a string, list, or dict');
      }
      case 'unary': {
        const v = this.evalExpr(expr.arg, scope);
        if (expr.op === '-') {
          if (typeof v !== 'number') throw new ScriptError('unary - expects a number');
          return -v;
        }
        return !truthy(v);
      }
      case 'binary':
        return this.evalBinary(expr, scope);
    }
  }

  private evalBinary(expr: Extract<Expr, { tag: 'binary' }>, scope: Scope): Value {
    const op = expr.op;
    if (op === '&&') {
      const l = this.evalExpr(expr.left, scope);
      return truthy(l) ? this.evalExpr(expr.right, scope) : l;
    }
    if (op === '||') {
      const l = this.evalExpr(expr.left, scope);
      return truthy(l) ? l : this.evalExpr(expr.right, scope);
    }
    const l = this.evalExpr(expr.left, scope);
    const r = this.evalExpr(expr.right, scope);
    switch (op) {
      case '+':
        if (typeof l === 'number' && typeof r === 'number') return l + r;
        if (typeof l === 'string' && typeof r === 'string') return l + r;
        if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
        throw new ScriptError("'+' expects two numbers, two strings, or two lists");
      case '-':
      case '*':
      case '/':
      case '%': {
        if (typeof l !== 'number' || typeof r !== 'number') {
          throw new ScriptError(`'${op}' expects two numbers`);
        }
        if (op === '-') return l - r;
        if (op === '*') return l * r;
        if (op === '/') {
          if (r === 0) throw new ScriptError('division by zero');
          return Math.trunc(l / r);
        }
        if (r === 0) throw new ScriptError('modulo by zero');
        return l % r;
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        if (typeof l !== 'number' || typeof r !== 'number') {
          throw new ScriptError(`'${op}' expects two numbers`);
        }
        if (op === '<') return l < r;
        if (op === '<=') return l <= r;
        if (op === '>') return l > r;
        return l >= r;
      }
      case '==':
        return valuesEqual(l, r);
      case '!=':
        return !valuesEqual(l, r);
    }
  }
}
