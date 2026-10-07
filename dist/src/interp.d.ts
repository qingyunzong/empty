/**
 * tail-safe-interp: a small tree-walking interpreter implemented as an
 * explicit stack machine (trampoline). The host (JS) call stack is never
 * consumed by guest recursion, so arbitrarily deep guest recursion is safe.
 *
 * Semantics implemented:
 *  - functions (named, recursive, mutually recursive), let, if, begin
 *  - throw / try-catch / try-finally
 *  - proper tail calls: a call in tail position reuses the caller's frame
 *    (same frame id) *only if* the caller has no pending finally/catch
 *    handler; otherwise a fresh frame is allocated
 *  - a finally block that throws overrides the original outcome (value or
 *    in-flight exception)
 *  - frame metering: allocated / reused / maxDepth
 *  - uncaught exceptions carry an explicit unwind trace of frame references
 *    ({ id, name }) in unwind order, innermost first
 */
export type Value = number | string | boolean | null;
export type Node = {
    t: 'lit';
    v: Value;
} | {
    t: 'sym';
    name: string;
} | {
    t: 'if';
    c: Node;
    a: Node;
    b: Node;
} | {
    t: 'begin';
    xs: Node[];
} | {
    t: 'let';
    name: string;
    v: Node;
    body: Node;
} | {
    t: 'call';
    fn: string;
    args: Node[];
} | {
    t: 'builtin';
    name: string;
    args: Node[];
} | {
    t: 'throw';
    e: Node;
} | {
    t: 'try';
    body: Node;
    catchVar?: string;
    catchBody?: Node;
    finallyBody?: Node;
};
export interface FnDef {
    name: string;
    params: string[];
    body: Node;
}
export interface Program {
    defs: FnDef[];
    main: Node;
}
export declare const lit: (v: Value) => Node;
export declare const sym: (name: string) => Node;
export declare const if_: (c: Node, a: Node, b: Node) => Node;
export declare const begin: (...xs: Node[]) => Node;
export declare const let_: (name: string, v: Node, body: Node) => Node;
export declare const call: (fn: string, ...args: Node[]) => Node;
export declare const op: (name: string, ...args: Node[]) => Node;
export declare const throw_: (e: Node) => Node;
export declare const try_: (body: Node, opts?: {
    catchVar?: string;
    catchBody?: Node;
    finallyBody?: Node;
}) => Node;
export declare const fn: (name: string, params: string[], body: Node) => FnDef;
export interface FrameRef {
    id: number;
    name: string;
}
/** A guest-level exception that escaped the program (uncaught). */
export declare class ScriptError extends Error {
    readonly value: Value;
    /** Frames unwound by this exception, innermost first. */
    readonly trace: FrameRef[];
    constructor(value: Value);
}
export interface Metrics {
    /** Fresh frame allocations (includes the initial <main> frame). */
    allocated: number;
    /** Tail-call frame reuses (frame slot kept, id unchanged). */
    reused: number;
    /** High-water mark of simultaneously live frames. */
    maxDepth: number;
}
export interface RunOptions {
    /** Maximum machine steps before aborting (runaway protection). */
    fuel?: number;
}
export interface RunResult {
    value: Value;
    metrics: Metrics;
    /** Values passed to the `log` builtin, in order. */
    output: Value[];
}
export declare function run(program: Program, options?: RunOptions): RunResult;
