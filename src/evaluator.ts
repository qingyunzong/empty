import { Expr } from "./expr";

export type DiagnosticCode =
  | "DIV_BY_ZERO"
  | "BLACK_HOLE"
  | "UNBOUND_VAR"
  | "BUDGET_EXCEEDED";

export class EvalDiagnostic extends Error {
  readonly code: DiagnosticCode;

  constructor(code: DiagnosticCode, message: string) {
    super(message);
    this.name = "EvalDiagnostic";
    this.code = code;
  }
}

export type TraceEvent =
  | { readonly type: "force"; readonly name: string }
  | { readonly type: "cache-hit"; readonly name: string; readonly outcome: "value" | "failure" }
  | { readonly type: "value"; readonly name: string; readonly value: number }
  | { readonly type: "failure"; readonly name: string; readonly code: DiagnosticCode }
  | { readonly type: "black-hole"; readonly name: string };

type Env = { bindings: Map<string, Thunk>; parent: Env } | null;

interface Thunk {
  readonly name: string;
  state: "unevaluated" | "in-progress" | "done" | "failed";
  expr?: Expr;
  env?: Env;
  value?: number;
  error?: EvalDiagnostic;
}

export interface EvaluatorOptions {
  /** Maximum number of AST nodes actually evaluated. Cache hits are free. */
  budget?: number;
  /** Force-order events are appended here as evaluation proceeds. */
  trace?: TraceEvent[];
}

export class Evaluator {
  private remaining: number;
  private consumed = 0;
  readonly trace: TraceEvent[];
  private readonly rootEnv: NonNullable<Env>;

  constructor(options: EvaluatorOptions = {}) {
    this.remaining = options.budget ?? Number.POSITIVE_INFINITY;
    this.trace = options.trace ?? [];
    this.rootEnv = { bindings: new Map(), parent: null };
  }

  /** Number of budget units (actually evaluated AST nodes) consumed so far. */
  get spent(): number {
    return this.consumed;
  }

  /** Install a lazy top-level binding, visible to later `force`/`evaluate` calls. */
  define(name: string, expr: Expr): void {
    this.rootEnv.bindings.set(name, {
      name,
      state: "unevaluated",
      expr,
      env: this.rootEnv,
    });
  }

  /** Force a top-level binding, using and updating its cached state. */
  force(name: string): number {
    const thunk = this.rootEnv.bindings.get(name);
    if (thunk === undefined) {
      throw new EvalDiagnostic("UNBOUND_VAR", `unbound variable '${name}'`);
    }
    return this.forceThunk(thunk);
  }

  /** Evaluate an expression in the root environment. */
  evaluate(expr: Expr): number {
    return this.evalExpr(expr, this.rootEnv);
  }

  private charge(): void {
    if (this.remaining <= 0) {
      throw new EvalDiagnostic("BUDGET_EXCEEDED", "evaluation budget exhausted");
    }
    this.remaining -= 1;
    this.consumed += 1;
  }

  private forceThunk(thunk: Thunk): number {
    switch (thunk.state) {
      case "done":
        this.trace.push({ type: "cache-hit", name: thunk.name, outcome: "value" });
        return thunk.value as number;
      case "failed":
        this.trace.push({ type: "cache-hit", name: thunk.name, outcome: "failure" });
        throw thunk.error;
      case "in-progress":
        this.trace.push({ type: "black-hole", name: thunk.name });
        throw new EvalDiagnostic(
          "BLACK_HOLE",
          `black hole: self-dependent lazy binding '${thunk.name}'`,
        );
      case "unevaluated": {
        this.trace.push({ type: "force", name: thunk.name });
        thunk.state = "in-progress";
        try {
          const value = this.evalExpr(thunk.expr as Expr, thunk.env as Env);
          thunk.state = "done";
          thunk.value = value;
          thunk.expr = undefined;
          thunk.env = undefined;
          this.trace.push({ type: "value", name: thunk.name, value });
          return value;
        } catch (err) {
          const diagnostic =
            err instanceof EvalDiagnostic
              ? err
              : new EvalDiagnostic("BLACK_HOLE", String(err));
          thunk.state = "failed";
          thunk.error = diagnostic;
          thunk.expr = undefined;
          thunk.env = undefined;
          this.trace.push({ type: "failure", name: thunk.name, code: diagnostic.code });
          throw diagnostic;
        }
      }
    }
  }

  private evalExpr(node: Expr, env: Env): number {
    switch (node.kind) {
      case "lit":
        this.charge();
        return node.value;
      case "bin": {
        this.charge();
        const left = this.evalExpr(node.left, env);
        const right = this.evalExpr(node.right, env);
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
        const thunk = lookup(env, node.name);
        if (thunk === undefined) {
          throw new EvalDiagnostic("UNBOUND_VAR", `unbound variable '${node.name}'`);
        }
        // Budget is only spent on nodes that are actually evaluated:
        // cache hits and black-hole re-entries cost nothing.
        if (thunk.state === "unevaluated") {
          this.charge();
        }
        return this.forceThunk(thunk);
      }
      case "let": {
        this.charge();
        const child: NonNullable<Env> = { bindings: new Map(), parent: env };
        // The binding is in scope in its own definition, so self-dependencies
        // are observed as black holes when forced.
        child.bindings.set(node.name, {
          name: node.name,
          state: "unevaluated",
          expr: node.value,
          env: child,
        });
        return this.evalExpr(node.body, child);
      }
    }
  }
}

function lookup(env: Env, name: string): Thunk | undefined {
  let current = env;
  while (current !== null) {
    const thunk = current.bindings.get(name);
    if (thunk !== undefined) {
      return thunk;
    }
    current = current.parent;
  }
  return undefined;
}

/** Convenience one-shot evaluation with a fresh evaluator. */
export function evaluateShared(expr: Expr, options: EvaluatorOptions = {}): number {
  return new Evaluator(options).evaluate(expr);
}
