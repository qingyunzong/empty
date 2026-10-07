import { Expr } from "./expr";
export type DiagnosticCode = "DIV_BY_ZERO" | "BLACK_HOLE" | "UNBOUND_VAR" | "BUDGET_EXCEEDED";
export declare class EvalDiagnostic extends Error {
    readonly code: DiagnosticCode;
    constructor(code: DiagnosticCode, message: string);
}
export type TraceEvent = {
    readonly type: "force";
    readonly name: string;
} | {
    readonly type: "cache-hit";
    readonly name: string;
    readonly outcome: "value" | "failure";
} | {
    readonly type: "value";
    readonly name: string;
    readonly value: number;
} | {
    readonly type: "failure";
    readonly name: string;
    readonly code: DiagnosticCode;
} | {
    readonly type: "black-hole";
    readonly name: string;
};
export interface EvaluatorOptions {
    /** Maximum number of AST nodes actually evaluated. Cache hits are free. */
    budget?: number;
    /** Force-order events are appended here as evaluation proceeds. */
    trace?: TraceEvent[];
}
export declare class Evaluator {
    private remaining;
    private consumed;
    readonly trace: TraceEvent[];
    private readonly rootEnv;
    constructor(options?: EvaluatorOptions);
    /** Number of budget units (actually evaluated AST nodes) consumed so far. */
    get spent(): number;
    /** Install a lazy top-level binding, visible to later `force`/`evaluate` calls. */
    define(name: string, expr: Expr): void;
    /** Force a top-level binding, using and updating its cached state. */
    force(name: string): number;
    /** Evaluate an expression in the root environment. */
    evaluate(expr: Expr): number;
    private charge;
    private forceThunk;
    private evalExpr;
}
/** Convenience one-shot evaluation with a fresh evaluator. */
export declare function evaluateShared(expr: Expr, options?: EvaluatorOptions): number;
