import {
  assertSafeInteger,
  BudgetExceededError,
  type CaptureResult,
  type ExternalAction,
  type TxLike,
} from "../src/txstate";

interface ModelFrame {
  vars: Map<string, number>;
  staged: ExternalAction[];
}

/**
 * Copy-stack reference model for TxState.
 *
 * Every savepoint physically copies the whole variable map and the staged
 * action list. Rollback pops the copy; commit replaces the parent frame
 * with the child frame; root commit publishes staged actions and makes the
 * current map the new baseline. A budget abort restores the baseline.
 */
export class ModelState implements TxLike {
  private baseline = new Map<string, number>();
  private stack: ModelFrame[] = [{ vars: new Map(), staged: [] }];
  private readonly publishedActions: ExternalAction[] = [];
  private readonly budget: number;
  private spent = 0;

  constructor(options: { budget?: number } = {}) {
    this.budget = options.budget ?? Number.POSITIVE_INFINITY;
  }

  depth(): number {
    return this.stack.length;
  }

  get(name: string): number {
    return this.top().vars.get(name) ?? 0;
  }

  set(name: string, value: number): void {
    assertSafeInteger(value, "value");
    this.spend();
    this.top().vars.set(name, value);
  }

  add(name: string, delta: number): void {
    assertSafeInteger(delta, "delta");
    this.spend();
    const next = this.get(name) + delta;
    assertSafeInteger(next, "result");
    this.top().vars.set(name, next);
  }

  stage(action: ExternalAction): void {
    this.spend();
    this.top().staged.push(action);
  }

  begin(): void {
    const parent = this.top();
    this.stack.push({ vars: new Map(parent.vars), staged: [...parent.staged] });
  }

  commit(): void {
    const frame = this.stack.pop()!;
    if (this.stack.length === 0) {
      this.baseline = new Map(frame.vars);
      this.publishedActions.push(...frame.staged);
      this.stack.push({ vars: new Map(frame.vars), staged: [] });
      return;
    }
    this.stack[this.stack.length - 1] = frame;
  }

  rollback(): void {
    this.stack.pop();
    if (this.stack.length === 0) {
      this.stack.push({ vars: new Map(this.baseline), staged: [] });
    }
  }

  capture<T>(fn: (tx: this) => T): CaptureResult<T> {
    this.begin();
    let value: T;
    try {
      value = fn(this);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        throw error;
      }
      this.rollback();
      return { ok: false, error };
    }
    this.commit();
    return { ok: true, value };
  }

  published(): readonly ExternalAction[] {
    return this.publishedActions;
  }

  private top(): ModelFrame {
    return this.stack[this.stack.length - 1]!;
  }

  private spend(): void {
    this.spent += 1;
    if (this.spent > this.budget) {
      this.stack = [{ vars: new Map(this.baseline), staged: [] }];
      this.spent = 0;
      throw new BudgetExceededError(
        `operation budget exceeded (budget=${this.budget})`,
      );
    }
  }
}
