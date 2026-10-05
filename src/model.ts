import { Budget } from './budget';
import { BudgetExhaustedError, TransactionError } from './errors';
import { CaptureResult, TxMachine } from './machine';
import { State, assertSafeInteger, copyState } from './util';

interface ModelFrame {
  state: State;
  staged: string[];
}

/**
 * Copy-stack reference model with the same semantics as UndoLogMachine.
 * Every begin() pushes a full copy of the current state; rollback() simply
 * discards the top copy; commit() adopts the top copy into its parent.
 * It is intentionally naive so it can serve as a differential-testing oracle.
 */
export class CopyStackModel implements TxMachine {
  private committedState: State = {};
  private stack: ModelFrame[] = [];
  private budget: Budget;
  private readonly publishedActions: string[] = [];

  constructor(options: { budget?: number | null } = {}) {
    this.budget = new Budget(options.budget ?? null);
  }

  get depth(): number {
    return this.stack.length;
  }

  get published(): readonly string[] {
    return this.publishedActions;
  }

  get budgetLeft(): number | null {
    return this.budget.left;
  }

  begin(): void {
    this.stack.push({ state: copyState(this.activeState()), staged: [] });
  }

  commit(): void {
    const frame = this.popFrame();
    const parent = this.stack[this.stack.length - 1];
    if (parent) {
      parent.state = frame.state;
      parent.staged.push(...frame.staged);
    } else {
      this.committedState = frame.state;
      this.publishedActions.push(...frame.staged);
    }
  }

  rollback(): void {
    this.popFrame();
  }

  capture(fn: () => void): CaptureResult {
    const entryDepth = this.stack.length;
    this.begin();
    try {
      fn();
    } catch (error) {
      while (this.stack.length > entryDepth) {
        this.rollback();
      }
      if (error instanceof BudgetExhaustedError) {
        throw error;
      }
      return { ok: false, error };
    }
    while (this.stack.length > entryDepth) {
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
    const state = this.activeState();
    return Object.prototype.hasOwnProperty.call(state, name) ? state[name] : 0;
  }

  snapshot(): State {
    return copyState(this.activeState());
  }

  drainPublished(): string[] {
    return this.publishedActions.splice(0, this.publishedActions.length);
  }

  run<T>(fn: () => T, options: { budget?: number | null } = {}): T {
    if (this.stack.length !== 0) {
      throw new TransactionError('run() cannot be nested inside an open transaction');
    }
    if (options.budget !== undefined) {
      this.budget = new Budget(options.budget);
    }
    this.begin();
    try {
      const value = fn();
      while (this.stack.length > 0) {
        this.commit();
      }
      return value;
    } catch (error) {
      while (this.stack.length > 0) {
        this.rollback();
      }
      throw error;
    }
  }

  private write(name: string, value: number): void {
    assertSafeInteger(value, `result for "${name}"`);
    const frame = this.currentFrame();
    this.budget.charge();
    frame.state[name] = value;
  }

  private activeState(): State {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1].state : this.committedState;
  }

  private currentFrame(): ModelFrame {
    const frame = this.stack[this.stack.length - 1];
    if (!frame) {
      throw new TransactionError('no open transaction');
    }
    return frame;
  }

  private popFrame(): ModelFrame {
    const frame = this.stack.pop();
    if (!frame) {
      throw new TransactionError('no open transaction');
    }
    return frame;
  }
}
