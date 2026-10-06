import { Expr, ParseError, parseFormula } from './parser';

export type CellError =
  | { type: 'div-by-zero' }
  | { type: 'cycle'; path: string[] }
  | { type: 'parse'; message: string };

export type Value = { ok: true; value: number } | { ok: false; error: CellError };

export function ok(value: number): Value {
  return { ok: true, value };
}

export function err(error: CellError): Value {
  return { ok: false, error };
}

class CycleSignal extends Error {
  constructor(public path: string[]) {
    super(`circular reference: ${path.join(' -> ')}`);
  }
}

class ErrorSignal extends Error {
  constructor(public cellError: CellError) {
    super(`cell error: ${cellError.type}`);
  }
}

interface Cell {
  source: string | null;
  ast: Expr | null;
  parseError: CellError | null;
  literal: number | null;
  value: Value;
  dirty: boolean;
  computing: boolean;
  deps: Set<string>;
  dependents: Set<string>;
}

const REF_PATTERN = /^[A-Za-z]+[0-9]+$/;

export function normalizeRef(ref: string): string {
  if (!REF_PATTERN.test(ref)) throw new Error(`invalid cell reference: "${ref}"`);
  return ref.toUpperCase();
}

function cloneError(error: CellError): CellError {
  if (error.type === 'cycle') return { type: 'cycle', path: [...error.path] };
  return { ...error };
}

function cloneValue(value: Value): Value {
  return value.ok ? { ok: true, value: value.value } : { ok: false, error: cloneError(value.error) };
}

export class Spreadsheet {
  private cells = new Map<string, Cell>();
  private txStack: Map<string, Cell>[] = [];

  private cell(ref: string): Cell {
    let c = this.cells.get(ref);
    if (!c) {
      c = {
        source: null,
        ast: null,
        parseError: null,
        literal: null,
        value: ok(0),
        dirty: false,
        computing: false,
        deps: new Set(),
        dependents: new Set(),
      };
      this.cells.set(ref, c);
    }
    return c;
  }

  set(ref: string, input: number | string): void {
    ref = normalizeRef(ref);
    const cell = this.cell(ref);
    if (typeof input === 'number') {
      if (!Number.isInteger(input)) throw new Error(`only integers are supported: ${input}`);
      cell.source = null;
      cell.ast = null;
      cell.parseError = null;
      cell.literal = input;
    } else {
      const text = input.startsWith('=') ? input.slice(1) : input;
      cell.source = input;
      cell.literal = null;
      try {
        cell.ast = parseFormula(text);
        cell.parseError = null;
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        cell.ast = null;
        cell.parseError = { type: 'parse', message: e.message };
      }
    }
    this.markDirty(ref);
  }

  get(ref: string): Value {
    ref = normalizeRef(ref);
    try {
      return this.resolve(ref, []);
    } catch (signal) {
      if (signal instanceof CycleSignal) return this.cell(ref).value;
      throw signal;
    }
  }

  formulaOf(ref: string): string | null {
    return this.cell(normalizeRef(ref)).source;
  }

  dependenciesOf(ref: string): string[] {
    return [...this.cell(normalizeRef(ref)).deps].sort();
  }

  dependentsOf(ref: string): string[] {
    return [...this.cell(normalizeRef(ref)).dependents].sort();
  }

  begin(): void {
    this.txStack.push(this.snapshot());
  }

  commit(): void {
    if (this.txStack.length === 0) throw new Error('commit without begin');
    this.txStack.pop();
  }

  rollback(): void {
    const snapshot = this.txStack.pop();
    if (!snapshot) throw new Error('rollback without begin');
    this.cells = snapshot;
  }

  private snapshot(): Map<string, Cell> {
    const copy = new Map<string, Cell>();
    for (const [ref, c] of this.cells) {
      copy.set(ref, {
        source: c.source,
        ast: c.ast,
        parseError: c.parseError ? { ...c.parseError } : null,
        literal: c.literal,
        value: cloneValue(c.value),
        dirty: c.dirty,
        computing: false,
        deps: new Set(c.deps),
        dependents: new Set(c.dependents),
      });
    }
    return copy;
  }

  private markDirty(ref: string): void {
    const cell = this.cell(ref);
    if (cell.dirty) return;
    cell.dirty = true;
    for (const dependent of cell.dependents) this.markDirty(dependent);
  }

  private resolve(ref: string, stack: string[]): Value {
    const cell = this.cell(ref);
    if (!cell.dirty) return cell.value;
    if (cell.computing) {
      const start = stack.indexOf(ref);
      throw new CycleSignal([...stack.slice(start), ref]);
    }
    cell.computing = true;
    stack.push(ref);
    for (const dep of cell.deps) this.cell(dep).dependents.delete(ref);
    cell.deps.clear();
    try {
      let value: Value;
      if (cell.parseError) {
        value = err(cell.parseError);
      } else if (cell.ast) {
        value = ok(this.evalExpr(cell.ast, ref, stack));
      } else {
        value = ok(cell.literal ?? 0);
      }
      if (value.ok && value.value === 0) value = ok(0);
      cell.value = value;
      cell.dirty = false;
      return value;
    } catch (signal) {
      if (signal instanceof CycleSignal) {
        cell.value = err({ type: 'cycle', path: [...signal.path] });
        cell.dirty = false;
        if (signal.path.includes(ref)) throw signal;
        return cell.value;
      }
      if (signal instanceof ErrorSignal) {
        cell.value = err(signal.cellError);
        cell.dirty = false;
        return cell.value;
      }
      throw signal;
    } finally {
      cell.computing = false;
      stack.pop();
    }
  }

  private readRef(reader: string, ref: string, stack: string[]): number {
    const readerCell = this.cell(reader);
    const depCell = this.cell(ref);
    readerCell.deps.add(ref);
    depCell.dependents.add(reader);
    const value = this.resolve(ref, stack);
    if (!value.ok) throw new ErrorSignal(value.error);
    return value.value;
  }

  private evalExpr(expr: Expr, reader: string, stack: string[]): number {
    switch (expr.kind) {
      case 'num':
        return expr.value;
      case 'ref':
        return this.readRef(reader, expr.ref, stack);
      case 'neg':
        return -this.evalExpr(expr.operand, reader, stack);
      case 'bin': {
        const left = this.evalExpr(expr.left, reader, stack);
        const right = this.evalExpr(expr.right, reader, stack);
        switch (expr.op) {
          case '+':
            return left + right;
          case '-':
            return left - right;
          case '*':
            return left * right;
          case '/':
            if (right === 0) throw new ErrorSignal({ type: 'div-by-zero' });
            return Math.trunc(left / right);
        }
        break;
      }
      case 'if': {
        const cond = this.evalExpr(expr.cond, reader, stack);
        return cond !== 0
          ? this.evalExpr(expr.thenBranch, reader, stack)
          : this.evalExpr(expr.elseBranch, reader, stack);
      }
    }
  }
}
