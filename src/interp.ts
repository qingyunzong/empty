import { Expr, Span } from './ast.js';

export interface EvalError {
  message: string;
  span: Span;
}

export interface EvalOutcome {
  value: number | null;
  error: EvalError | null;
  log: number[];
}

class Raise {
  constructor(public readonly error: EvalError) {}
}

/**
 * Left-to-right evaluator for 32-bit signed integer expressions.
 * Arithmetic overflows wrap (int32 semantics); division and modulo by zero
 * raise an integer error. Evaluation stops at the first error; log entries
 * emitted before the error are preserved.
 */
export function evaluate(root: Expr): EvalOutcome {
  const log: number[] = [];
  const env = new Map<string, number>();

  function ev(e: Expr): number {
    switch (e.kind) {
      case 'const':
        return e.value | 0;
      case 'var': {
        const v = env.get(e.name);
        if (v === undefined) {
          throw new Raise({ message: `unbound variable: ${e.name}`, span: e.span });
        }
        return v;
      }
      case 'bin': {
        const l = ev(e.left);
        const r = ev(e.right);
        switch (e.op) {
          case '+': return (l + r) | 0;
          case '-': return (l - r) | 0;
          case '*': return Math.imul(l, r);
          case '/':
            if (r === 0) throw new Raise({ message: 'integer division by zero', span: e.span });
            return Math.trunc(l / r) | 0;
          case '%':
            if (r === 0) throw new Raise({ message: 'integer modulo by zero', span: e.span });
            return (l % r) | 0;
        }
        break;
      }
      case 'log': {
        const v = ev(e.expr);
        log.push(v);
        return v;
      }
      case 'if': {
        return ev(e.cond) !== 0 ? ev(e.then) : ev(e.else);
      }
      case 'let': {
        const v = ev(e.value);
        const had = env.has(e.name);
        const old = env.get(e.name);
        env.set(e.name, v);
        try {
          return ev(e.body);
        } finally {
          if (had) env.set(e.name, old as number);
          else env.delete(e.name);
        }
      }
    }
  }

  try {
    return { value: ev(root), error: null, log };
  } catch (err) {
    if (err instanceof Raise) return { value: null, error: err.error, log };
    throw err;
  }
}
