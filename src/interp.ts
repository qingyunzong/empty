import type { Expr } from './expr.js';
import { DivisionByZeroError, UnboundVariableError } from './errors.js';

/**
 * Reference interpreter: lazy (bindings evaluated on demand) but non-sharing —
 * every variable occurrence re-evaluates its binding from scratch. Used to
 * cross-check the numeric results of the caching evaluator. Operands are
 * evaluated left-to-right, matching the shared evaluator, so the first
 * diagnostic encountered is identical in both.
 */
export function interpret(expr: Expr, env: ReadonlyMap<string, Expr> = new Map()): number {
  switch (expr.kind) {
    case 'lit':
      return expr.value;
    case 'add':
    case 'sub':
    case 'mul':
    case 'div': {
      const left = interpret(expr.left, env);
      const right = interpret(expr.right, env);
      switch (expr.kind) {
        case 'add':
          return left + right;
        case 'sub':
          return left - right;
        case 'mul':
          return left * right;
        case 'div':
          if (right === 0) throw new DivisionByZeroError();
          return Math.trunc(left / right);
      }
    }
    case 'var': {
      const bound = env.get(expr.name);
      if (!bound) throw new UnboundVariableError(expr.name);
      return interpret(bound, env);
    }
    case 'let': {
      const inner = new Map(env);
      inner.set(expr.name, expr.value);
      return interpret(expr.body, inner);
    }
  }
}
