import type { Expr } from './expr.js';
import {
  BlackHoleError,
  BudgetExhaustedError,
  DivisionByZeroError,
  EvalError,
  UnboundVariableError,
} from './errors.js';

export type EvalResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: EvalError };

type State =
  | { readonly tag: 'new' }
  | { readonly tag: 'busy' }
  | { readonly tag: 'done'; readonly value: number }
  | { readonly tag: 'failed'; readonly error: EvalError };

/** A compiled, shareable lazy node. */
export interface Thunk {
  readonly label: string;
  state: State;
  compute: () => number;
}

const fresh = (label: string, compute: () => number): Thunk => ({
  label,
  state: { tag: 'new' },
  compute,
});

export interface EvaluatorOptions {
  /** Maximum number of nodes that may actually be evaluated. Cache hits are free. */
  readonly budget?: number;
}

/**
 * Graph-reduction style evaluator. Every expression node compiles to a thunk;
 * `let` bindings are compiled exactly once and shared by every reference, so
 * the first force caches the outcome — success or failure — and later forces
 * replay the identical value or diagnostic.
 */
export class LazyEvaluator {
  /** Labels of nodes whose evaluation actually started, in forcing order. */
  readonly trace: string[] = [];

  private budget: number;
  private evaluated = 0;

  constructor(options: EvaluatorOptions = {}) {
    this.budget = options.budget ?? Number.POSITIVE_INFINITY;
  }

  /** Number of nodes actually evaluated so far (cache hits excluded). */
  get evaluations(): number {
    return this.evaluated;
  }

  get remainingBudget(): number {
    return this.budget;
  }

  addBudget(amount: number): void {
    this.budget += amount;
  }

  compile(expr: Expr): Thunk {
    return this.build(expr, new Map());
  }

  /** Force a thunk to a value, never throwing: failures come back as results. */
  force(thunk: Thunk): EvalResult {
    try {
      return { ok: true, value: this.forceValue(thunk) };
    } catch (error) {
      if (error instanceof EvalError) return { ok: false, error };
      throw error;
    }
  }

  run(expr: Expr): EvalResult {
    return this.force(this.compile(expr));
  }

  private forceValue(thunk: Thunk): number {
    const state = thunk.state;
    switch (state.tag) {
      case 'done':
        return state.value;
      case 'failed':
        throw state.error;
      case 'busy': {
        const error = new BlackHoleError(thunk.label);
        thunk.state = { tag: 'failed', error };
        throw error;
      }
    }

    if (this.budget <= 0) throw new BudgetExhaustedError();
    this.budget -= 1;
    this.evaluated += 1;
    this.trace.push(thunk.label);
    thunk.state = { tag: 'busy' };

    try {
      const value = thunk.compute();
      thunk.state = { tag: 'done', value };
      return value;
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        // Not a real outcome: leave the node unevaluated so it can be retried.
        thunk.state = { tag: 'new' };
      } else if (thunk.state.tag === 'busy') {
        // First failure wins; the identical diagnostic is replayed forever.
        thunk.state = { tag: 'failed', error: error as EvalError };
      }
      throw error;
    }
  }

  private build(expr: Expr, env: ReadonlyMap<string, Thunk>): Thunk {
    switch (expr.kind) {
      case 'lit':
        return fresh(`lit(${expr.value})`, () => expr.value);
      case 'add':
      case 'sub':
      case 'mul':
      case 'div': {
        const left = this.build(expr.left, env);
        const right = this.build(expr.right, env);
        return fresh(expr.kind, () => {
          const l = this.forceValue(left);
          const r = this.forceValue(right);
          switch (expr.kind) {
            case 'add':
              return l + r;
            case 'sub':
              return l - r;
            case 'mul':
              return l * r;
            case 'div':
              if (r === 0) throw new DivisionByZeroError();
              return Math.trunc(l / r);
          }
        });
      }
      case 'var': {
        const bound = env.get(expr.name);
        if (bound) return bound;
        return fresh(`var(${expr.name})`, () => {
          throw new UnboundVariableError(expr.name);
        });
      }
      case 'let': {
        // The binding thunk is created before its definition is compiled, so
        // the name is recursively in scope and shared by every occurrence.
        const shared: Thunk = {
          label: expr.name,
          state: { tag: 'new' },
          compute: () => {
            throw new Error('uninitialized thunk');
          },
        };
        const inner = new Map(env);
        inner.set(expr.name, shared);
        const definition = this.build(expr.value, inner);
        shared.compute = () => this.forceValue(definition);
        const body = this.build(expr.body, inner);
        return fresh(`let ${expr.name}`, () => this.forceValue(body));
      }
    }
  }
}
