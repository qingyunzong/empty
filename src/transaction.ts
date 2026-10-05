import { Budget } from './budget';
import { BudgetExhaustedError, TransactionError } from './errors';
import { CaptureResult, TxMachine } from './machine';
import { State, assertSafeInteger, copyState } from './util';

type UndoEntry = [name: string, previous: number | undefined];

interface Frame {
  undo: UndoEntry[];
  staged: string[];
}

/**
 * Integer-state transaction machine backed by per-frame undo logs.
 *
 * Semantics:
 * - begin() opens a nested savepoint; commit()/rollback() close the innermost one.
 * - An inner rollback undoes only the writes of its own layer.
 * - An inner commit merges its undo entries and staged actions into the parent layer.
 * - Staged external actions are published only when the outermost layer commits.
 * - capture(fn) runs fn in a savepoint: on error the layer is rolled back and the
 *   error is reported instead of thrown (except BudgetExhaustedError, which always
 *   propagates so that budget termination aborts the whole run).
 * - Every set/add/mul/stage costs 1 budget unit; when the budget is exhausted a
 *   BudgetExhaustedError is thrown and run() rolls back every open layer.
 */
export class UndoLogMachine implements TxMachine {
  private state: State = {};
  private frames: Frame[] = [];
  private budget: Budget;
  private readonly publishedActions: string[] = [];

  constructor(options: { budget?: number | null } = {}) {
    this.budget = new Budget(options.budget ?? null);
  }

  get depth(): number {
    return this.frames.length;
  }

  get published(): readonly string[] {
    return this.publishedActions;
  }

  get budgetLeft(): number | null {
    return this.budget.left;
  }

  begin(): void {
    this.frames.push({ undo: [], staged: [] });
  }

  commit(): void {
    const frame = this.popFrame();
    const parent = this.frames[this.frames.length - 1];
    if (parent) {
      parent.undo.push(...frame.undo);
      parent.staged.push(...frame.staged);
    } else {
      this.publishedActions.push(...frame.staged);
    }
  }

  rollback(): void {
    const frame = this.popFrame();
    for (let i = frame.undo.length - 1; i >= 0; i -= 1) {
      const [name, previous] = frame.undo[i];
      if (previous === undefined) {
        delete this.state[name];
      } else {
        this.state[name] = previous;
      }
    }
  }

  capture(fn: () => void): CaptureResult {
    const entryDepth = this.frames.length;
    this.begin();
    try {
      fn();
    } catch (error) {
      while (this.frames.length > entryDepth) {
        this.rollback();
      }
      if (error instanceof BudgetExhaustedError) {
        throw error;
      }
      return { ok: false, error };
    }
    while (this.frames.length > entryDepth) {
      this.commit();
    }
    return { ok: true };
  }

  set(name: string, value: number): void {
    assertSafeInteger(value, `value for "${name}"`);
    this.write(name, value);
  }

  add(name: string, delta: number): void {
    assertSafeInteger(delta, 'delta');
    this.write(name, this.get(name) + delta);
  }

  mul(name: string, factor: number): void {
    assertSafeInteger(factor, 'factor');
    this.write(name, this.get(name) * factor);
  }

  stage(action: string): void {
    const frame = this.currentFrame();
    this.budget.charge();
    frame.staged.push(action);
  }

  get(name: string): number {
    return Object.prototype.hasOwnProperty.call(this.state, name) ? this.state[name] : 0;
  }

  snapshot(): State {
    return copyState(this.state);
  }

  drainPublished(): string[] {
    return this.publishedActions.splice(0, this.publishedActions.length);
  }

  run<T>(fn: () => T, options: { budget?: number | null } = {}): T {
    if (this.frames.length !== 0) {
      throw new TransactionError('run() cannot be nested inside an open transaction');
    }
    if (options.budget !== undefined) {
      this.budget = new Budget(options.budget);
    }
    this.begin();
    try {
      const value = fn();
      while (this.frames.length > 0) {
        this.commit();
      }
      return value;
    } catch (error) {
      while (this.frames.length > 0) {
        this.rollback();
      }
      throw error;
    }
  }

  private write(name: string, value: number): void {
    assertSafeInteger(value, `result for "${name}"`);
    const frame = this.currentFrame();
    this.budget.charge();
    const previous = Object.prototype.hasOwnProperty.call(this.state, name)
      ? this.state[name]
      : undefined;
    frame.undo.push([name, previous]);
    this.state[name] = value;
  }

  private currentFrame(): Frame {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) {
      throw new TransactionError('no open transaction');
    }
    return frame;
  }

  private popFrame(): Frame {
    const frame = this.frames.pop();
    if (!frame) {
      throw new TransactionError('no open transaction');
    }
    return frame;
  }
}
