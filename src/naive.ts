import { Expr } from "./expr";
import { EvalDiagnostic } from "./evaluator";

type Closure = { readonly expr: Expr; readonly env: NEnv };
type NEnv = { bindings: Map<string, Closure>; parent: NEnv } | null;

export interface NaiveStats {
  /** Number of AST nodes evaluated; re-evaluated nodes are counted every time. */
  steps: number;
}

/**
 * Non-shared call-by-name interpreter used to cross-check the shared lazy
 * evaluator. Every variable reference re-evaluates the bound expression;
 * nothing is cached. Self-dependencies are still reported as black holes
 * instead of diverging.
 */
export function evaluateNaive(root: Expr, stats: NaiveStats = { steps: 0 }): number {
  const active = new Set<Closure>();

  function evalNode(node: Expr, env: NEnv): number {
    stats.steps += 1;
    switch (node.kind) {
      case "lit":
        return node.value;
      case "bin": {
        const left = evalNode(node.left, env);
        const right = evalNode(node.right, env);
        switch (node.op) {
          case "add":
            return left + right;
          case "sub":
            return left - right;
          case "mul":
            return left * right;
          case "div":
            if (right === 0) {
              throw new EvalDiagnostic("DIV_BY_ZERO", "division by zero");
            }
            return Math.trunc(left / right);
        }
        break;
      }
      case "var": {
        const closure = lookupNaive(env, node.name);
        if (closure === undefined) {
          throw new EvalDiagnostic("UNBOUND_VAR", `unbound variable '${node.name}'`);
        }
        if (active.has(closure)) {
          throw new EvalDiagnostic(
            "BLACK_HOLE",
            `black hole: self-dependent binding '${node.name}'`,
          );
        }
        active.add(closure);
        try {
          return evalNode(closure.expr, closure.env);
        } finally {
          active.delete(closure);
        }
      }
      case "let": {
        const child: NonNullable<NEnv> = { bindings: new Map(), parent: env };
        child.bindings.set(node.name, { expr: node.value, env: child });
        return evalNode(node.body, child);
      }
    }
  }

  return evalNode(root, null);
}

function lookupNaive(env: NEnv, name: string): Closure | undefined {
  let current = env;
  while (current !== null) {
    const closure = current.bindings.get(name);
    if (closure !== undefined) {
      return closure;
    }
    current = current.parent;
  }
  return undefined;
}
