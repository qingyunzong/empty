export class BudgetExceededError extends Error {
  constructor(message = "operation budget exceeded") {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface ExternalAction {
  kind: string;
  payload: number;
}

export type CaptureResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export interface TxStateOptions {
  /** Max state-changing ops (set/add/stage) before a budget abort. Default: unlimited. */
  budget?: number;
}

export interface TxLike {
  get(name: string): number;
  set(name: string, value: number): void;
  add(name: string, delta: number): void;
  stage(action: ExternalAction): void;
  begin(): void;
  commit(): void;
  rollback(): void;
  capture<T>(fn: (tx: this) => T): CaptureResult<T>;
  depth(): number;
  published(): readonly ExternalAction[];
}

export function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer, got ${value}`);
  }
}

interface UndoEntry {
  name: string;
  existed: boolean;
  prev: number;
}

interface Frame {
  undo: UndoEntry[];
  staged: ExternalAction[];
}

function emptyFrame(): Frame {
  return { undo: [], staged: [] };
}

/**
 * Transactional integer state store.
 *
 * - Nested savepoints: begin/commit/rollback form a stack of layers.
 *   An inner rollback undoes only its own layer; an inner commit merges
 *   its changes (and staged actions) into the parent layer.
 * - Staged external actions are published only when the outermost (root)
 *   layer commits; any rollback discards the staged actions of its layer.
 * - capture(fn) runs fn in a fresh savepoint: exceptions roll back that
 *   savepoint and are returned as { ok: false, error }. BudgetExceededError
 *   is never captured; it aborts the whole session.
 * - Budget: when the op budget is exceeded, every open layer is rolled
 *   back to the last committed baseline, all staged actions are discarded,
 *   and BudgetExceededError is thrown. The store stays usable afterwards
 *   with a fresh budget.
 */
export class TxState implements TxLike {
  private readonly vars = new Map<string, number>();
  private frames: Frame[] = [emptyFrame()];
  private readonly publishedActions: ExternalAction[] = [];
  private readonly budget: number;
  private spent = 0;

  constructor(options: TxStateOptions = {}) {
    this.budget = options.budget ?? Number.POSITIVE_INFINITY;
  }

  depth(): number {
    return this.frames.length;
  }

  get(name: string): number {
    return this.vars.get(name) ?? 0;
  }

  set(name: string, value: number): void {
    assertSafeInteger(value, "value");
    this.spend();
    this.recordUndo(name);
    this.vars.set(name, value);
  }

  add(name: string, delta: number): void {
    assertSafeInteger(delta, "delta");
    this.spend();
    const next = this.get(name) + delta;
    assertSafeInteger(next, "result");
    this.recordUndo(name);
    this.vars.set(name, next);
  }

  stage(action: ExternalAction): void {
    this.spend();
    this.top().staged.push(action);
  }

  begin(): void {
    this.frames.push(emptyFrame());
  }

  commit(): void {
    const frame = this.frames.pop()!;
    if (this.frames.length === 0) {
      this.publishedActions.push(...frame.staged);
      this.frames.push(emptyFrame());
      return;
    }
    const parent = this.top();
    parent.undo.push(...frame.undo);
    parent.staged.push(...frame.staged);
  }

  rollback(): void {
    const frame = this.frames.pop()!;
    this.applyUndo(frame);
    if (this.frames.length === 0) {
      this.frames.push(emptyFrame());
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

  private top(): Frame {
    return this.frames[this.frames.length - 1]!;
  }

  private recordUndo(name: string): void {
    this.top().undo.push({
      name,
      existed: this.vars.has(name),
      prev: this.vars.get(name) ?? 0,
    });
  }

  private applyUndo(frame: Frame): void {
    for (let i = frame.undo.length - 1; i >= 0; i--) {
      const entry = frame.undo[i]!;
      if (entry.existed) {
        this.vars.set(entry.name, entry.prev);
      } else {
        this.vars.delete(entry.name);
      }
    }
  }

  private spend(): void {
    this.spent += 1;
    if (this.spent > this.budget) {
      this.abortAll();
      throw new BudgetExceededError(
        `operation budget exceeded (budget=${this.budget})`,
      );
    }
  }

  private abortAll(): void {
    while (this.frames.length > 0) {
      const frame = this.frames.pop()!;
      this.applyUndo(frame);
    }
    this.frames.push(emptyFrame());
    this.spent = 0;
  }
}
