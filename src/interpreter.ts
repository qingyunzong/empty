import type { BinOp, Expr } from "./ast.ts";

export type Value = number | boolean | Closure;

export interface Closure {
  readonly tag: "closure";
  readonly name: string | null;
  readonly params: string[];
  readonly body: Expr;
  env: Env;
}

type Env = EnvNode | null;
interface EnvNode {
  name: string;
  value: Value;
  parent: Env;
}

function extend(env: Env, name: string, value: Value): Env {
  return { name, value, parent: env };
}

function lookup(env: Env, name: string): Value {
  for (let node = env; node !== null; node = node.parent) {
    if (node.name === name) return node.value;
  }
  throw new Error(`unbound variable: ${name}`);
}

export interface Frame {
  id: number;
  name: string;
  env: Env;
  pendingFinally: number;
}

export interface FrameMeter {
  allocated: number;
  reused: number;
  live: number;
  maxLive: number;
}

export type TraceEvent =
  | { type: "enter"; frameId: number; name: string }
  | { type: "reuse"; frameId: number; name: string }
  | { type: "exit"; frameId: number }
  | { type: "unwind"; frameId: number }
  | { type: "finally"; frameId: number }
  | { type: "catch"; frameId: number };

export interface Thrown {
  value: Value;
  frames: number[];
}

type Resume = { type: "value" } | { type: "throw"; error: Thrown };

type Task =
  | { kind: "eval"; expr: Expr; env: Env; tail: boolean }
  | { kind: "halt" }
  | { kind: "binRight"; op: BinOp; right: Expr; env: Env }
  | { kind: "binApply"; op: BinOp; left: Value }
  | { kind: "letBody"; name: string; body: Expr; env: Env; tail: boolean }
  | { kind: "ifK"; then: Expr; otherwise: Expr; env: Env; tail: boolean }
  | { kind: "seqK"; rest: Expr[]; env: Env; tail: boolean }
  | { kind: "callArgs"; args: Expr[]; env: Env; tail: boolean }
  | { kind: "argCollect"; fn: Closure; values: Value[]; rest: Expr[]; env: Env; tail: boolean }
  | { kind: "throwK" }
  | { kind: "catchK"; param: string; body: Expr; env: Env }
  | { kind: "finallyK"; body: Expr; env: Env; frame: Frame | null }
  | { kind: "finallyDone"; resume: Resume; frame: Frame | null }
  | { kind: "framePop"; frame: Frame };

export type RunResult =
  | { status: "ok"; value: Value; meter: FrameMeter; trace: TraceEvent[] }
  | { status: "throw"; error: Thrown; meter: FrameMeter; trace: TraceEvent[] };

export class InterpretedError extends Error {
  constructor(public readonly thrown: Thrown) {
    super("uncaught interpreted exception");
    this.name = "InterpretedError";
  }
}

export function run(expr: Expr): RunResult {
  return new Machine().run(expr);
}

export function evaluate(expr: Expr): Value {
  const result = run(expr);
  if (result.status === "throw") throw new InterpretedError(result.error);
  return result.value;
}

function applyBin(op: BinOp, left: Value, right: Value): Value {
  if (typeof left === "number" && typeof right === "number") {
    switch (op) {
      case "+": return left + right;
      case "-": return left - right;
      case "*": return left * right;
      case "==": return left === right;
      case "<": return left < right;
    }
  }
  if (op === "==" && typeof left === "boolean" && typeof right === "boolean") {
    return left === right;
  }
  throw new Error(`bad operands for operator ${op}`);
}

class Machine {
  private tasks: Task[] = [];
  private values: Value[] = [];
  private frames: Frame[] = [];
  private nextFrameId = 1;
  private error: Thrown | null = null;
  private thrown: Thrown | null = null;
  private readonly meter: FrameMeter = { allocated: 0, reused: 0, live: 0, maxLive: 0 };
  private readonly trace: TraceEvent[] = [];

  run(expr: Expr): RunResult {
    this.tasks.push({ kind: "halt" });
    this.pushEval(expr, null, false);
    while (this.tasks.length > 0) {
      const task = this.tasks.pop()!;
      if (this.error !== null) this.unwind(task, this.error);
      else this.exec(task);
    }
    const meter = { ...this.meter };
    if (this.thrown !== null) {
      return { status: "throw", error: this.thrown, meter, trace: this.trace };
    }
    return { status: "ok", value: this.values.pop() ?? false, meter, trace: this.trace };
  }

  private currentFrame(): Frame | null {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1] : null;
  }

  private pushEval(expr: Expr, env: Env, tail: boolean): void {
    this.tasks.push({ kind: "eval", expr, env, tail });
  }

  private popValue(): Value {
    const value = this.values.pop();
    if (value === undefined) throw new Error("machine invariant: empty value stack");
    return value;
  }

  private exec(task: Task): void {
    switch (task.kind) {
      case "eval":
        this.evalExpr(task.expr, task.env, task.tail);
        break;
      case "halt":
        break;
      case "binRight": {
        const left = this.popValue();
        this.tasks.push({ kind: "binApply", op: task.op, left });
        this.pushEval(task.right, task.env, false);
        break;
      }
      case "binApply": {
        const right = this.popValue();
        this.values.push(applyBin(task.op, task.left, right));
        break;
      }
      case "letBody": {
        const value = this.popValue();
        this.pushEval(task.body, extend(task.env, task.name, value), task.tail);
        break;
      }
      case "ifK": {
        const cond = this.popValue();
        this.pushEval(cond === true ? task.then : task.otherwise, task.env, task.tail);
        break;
      }
      case "seqK": {
        this.popValue();
        const [next, ...rest] = task.rest;
        if (rest.length > 0) {
          this.tasks.push({ kind: "seqK", rest, env: task.env, tail: task.tail });
        }
        this.pushEval(next, task.env, rest.length === 0 ? task.tail : false);
        break;
      }
      case "callArgs": {
        const fn = this.popValue();
        if (typeof fn !== "object") throw new Error("attempted to call a non-function");
        if (task.args.length === 0) {
          this.doCall(fn, [], task.tail);
        } else {
          this.tasks.push({
            kind: "argCollect",
            fn,
            values: [],
            rest: task.args.slice(1),
            env: task.env,
            tail: task.tail,
          });
          this.pushEval(task.args[0], task.env, false);
        }
        break;
      }
      case "argCollect": {
        task.values.push(this.popValue());
        if (task.rest.length === 0) {
          this.doCall(task.fn, task.values, task.tail);
        } else {
          this.tasks.push({ ...task, rest: task.rest.slice(1) });
          this.pushEval(task.rest[0], task.env, false);
        }
        break;
      }
      case "throwK": {
        const value = this.popValue();
        this.error = { value, frames: [] };
        break;
      }
      case "catchK":
        break;
      case "finallyK": {
        this.trace.push({ type: "finally", frameId: this.currentFrame()?.id ?? 0 });
        this.tasks.push({ kind: "finallyDone", resume: { type: "value" }, frame: task.frame });
        this.pushEval(task.body, task.env, false);
        break;
      }
      case "finallyDone": {
        this.popValue();
        if (task.frame !== null) task.frame.pendingFinally--;
        if (task.resume.type === "throw") this.error = task.resume.error;
        break;
      }
      case "framePop": {
        this.frames.pop();
        this.meter.live--;
        this.trace.push({ type: "exit", frameId: task.frame.id });
        break;
      }
    }
  }

  private unwind(task: Task, error: Thrown): void {
    switch (task.kind) {
      case "catchK": {
        this.trace.push({ type: "catch", frameId: this.currentFrame()?.id ?? 0 });
        this.error = null;
        this.pushEval(task.body, extend(task.env, task.param, error.value), false);
        break;
      }
      case "finallyK": {
        this.trace.push({ type: "finally", frameId: this.currentFrame()?.id ?? 0 });
        this.error = null;
        this.tasks.push({
          kind: "finallyDone",
          resume: { type: "throw", error },
          frame: task.frame,
        });
        this.pushEval(task.body, task.env, false);
        break;
      }
      case "framePop": {
        this.frames.pop();
        this.meter.live--;
        error.frames.push(task.frame.id);
        this.trace.push({ type: "unwind", frameId: task.frame.id });
        break;
      }
      case "halt": {
        this.thrown = error;
        this.error = null;
        break;
      }
      default:
        break;
    }
  }

  private evalExpr(expr: Expr, env: Env, tail: boolean): void {
    switch (expr.tag) {
      case "num":
      case "bool":
        this.values.push(expr.value);
        break;
      case "var":
        this.values.push(lookup(env, expr.name));
        break;
      case "bin":
        this.tasks.push({ kind: "binRight", op: expr.op, right: expr.right, env });
        this.pushEval(expr.left, env, false);
        break;
      case "let":
        this.tasks.push({ kind: "letBody", name: expr.name, body: expr.body, env, tail });
        this.pushEval(expr.init, env, false);
        break;
      case "fun": {
        const closure: Closure = {
          tag: "closure",
          name: expr.name,
          params: expr.params,
          body: expr.body,
          env,
        };
        if (expr.name !== null) closure.env = extend(env, expr.name, closure);
        this.values.push(closure);
        break;
      }
      case "call":
        this.tasks.push({ kind: "callArgs", args: expr.args, env, tail });
        this.pushEval(expr.callee, env, false);
        break;
      case "if":
        this.tasks.push({ kind: "ifK", then: expr.then, otherwise: expr.else, env, tail });
        this.pushEval(expr.cond, env, false);
        break;
      case "seq": {
        if (expr.exprs.length === 0) {
          this.values.push(false);
          break;
        }
        const [first, ...rest] = expr.exprs;
        if (rest.length > 0) {
          this.tasks.push({ kind: "seqK", rest, env, tail });
        }
        this.pushEval(first, env, rest.length === 0 ? tail : false);
        break;
      }
      case "throw":
        this.tasks.push({ kind: "throwK" });
        this.pushEval(expr.value, env, false);
        break;
      case "try": {
        const frame = this.currentFrame();
        if (expr.finallyBody !== null) {
          if (frame !== null) frame.pendingFinally++;
          this.tasks.push({ kind: "finallyK", body: expr.finallyBody, env, frame });
        }
        if (expr.catchBody !== null && expr.catchParam !== null) {
          this.tasks.push({ kind: "catchK", param: expr.catchParam, body: expr.catchBody, env });
        }
        this.pushEval(expr.body, env, false);
        break;
      }
    }
  }

  private doCall(fn: Closure, args: Value[], tail: boolean): void {
    if (args.length !== fn.params.length) {
      throw new Error(
        `arity mismatch calling ${fn.name ?? "<anon>"}: expected ${fn.params.length}, got ${args.length}`,
      );
    }
    let env = fn.env;
    for (let i = 0; i < args.length; i++) {
      env = extend(env, fn.params[i], args[i]);
    }
    const current = this.currentFrame();
    if (tail && current !== null && current.pendingFinally === 0) {
      current.env = env;
      current.name = fn.name ?? current.name;
      this.meter.reused++;
      this.trace.push({ type: "reuse", frameId: current.id, name: current.name });
    } else {
      const frame: Frame = {
        id: this.nextFrameId++,
        name: fn.name ?? "<anon>",
        env,
        pendingFinally: 0,
      };
      this.frames.push(frame);
      this.meter.allocated++;
      this.meter.live++;
      if (this.meter.live > this.meter.maxLive) this.meter.maxLive = this.meter.live;
      this.tasks.push({ kind: "framePop", frame });
      this.trace.push({ type: "enter", frameId: frame.id, name: frame.name });
    }
    this.pushEval(fn.body, env, true);
  }
}
