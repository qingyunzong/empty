import type { Expr, Program } from './ast.ts';
import { BudgetExhaustedError, EvalError } from './errors.ts';

export interface Closure {
  params: string[];
  body: Expr;
  env: Frame;
}

export type Value = bigint | boolean | Closure;

export type HostValue = Value | (() => Value);

type Thunk = {
  state: 'pending' | 'done' | 'error';
  value?: Value;
  error?: unknown;
} & ({ kind: 'expr'; node: Expr; env: Frame } | { kind: 'host'; run: () => Value });

export class Frame {
  readonly cells: Map<string, Value | Thunk>;
  readonly parent: Frame | null;

  constructor(parent: Frame | null) {
    this.cells = new Map();
    this.parent = parent;
  }

  lookup(name: string): Value | Thunk | undefined {
    let frame: Frame | null = this;
    while (frame !== null) {
      const cell = frame.cells.get(name);
      if (cell !== undefined) return cell;
      frame = frame.parent;
    }
    return undefined;
  }
}

function isThunk(cell: Value | Thunk): cell is Thunk {
  return typeof cell === 'object' && cell !== null && 'state' in cell;
}

function isClosure(value: Value): value is Closure {
  return typeof value === 'object' && value !== null && 'params' in value;
}

function typeName(value: Value): string {
  if (typeof value === 'bigint') return 'integer';
  if (typeof value === 'boolean') return 'boolean';
  return 'function';
}

interface Ctx {
  source: string;
}

type EvalGen<T> = Generator<null, T, void>;

function* forceThunk(thunk: Thunk, ctx: Ctx): EvalGen<Value> {
  if (thunk.state === 'done') return thunk.value as Value;
  if (thunk.state === 'error') throw thunk.error;
  try {
    const value = thunk.kind === 'host' ? thunk.run() : yield* evalExpr(thunk.node, thunk.env, ctx);
    thunk.state = 'done';
    thunk.value = value;
    return value;
  } catch (error) {
    thunk.state = 'error';
    thunk.error = error;
    throw error;
  }
}

function* evalExpr(node: Expr, env: Frame, ctx: Ctx): EvalGen<Value> {
  yield null; // one evaluation step
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'bool':
      return node.value;
    case 'var': {
      const cell = env.lookup(node.name);
      if (cell === undefined) {
        throw new EvalError(`Unknown variable '${node.name}'`, node.span, ctx.source);
      }
      if (isThunk(cell)) return yield* forceThunk(cell, ctx);
      return cell;
    }
    case 'unary': {
      const value = yield* evalExpr(node.expr, env, ctx);
      if (node.op === '-') {
        if (typeof value !== 'bigint') {
          throw new EvalError(`Unary '-' expects an integer, got ${typeName(value)}`, node.span, ctx.source);
        }
        return -value;
      }
      if (typeof value !== 'boolean') {
        throw new EvalError(`'!' expects a boolean, got ${typeName(value)}`, node.span, ctx.source);
      }
      return !value;
    }
    case 'binary':
      return yield* evalBinary(node, env, ctx);
    case 'cond': {
      const cond = yield* evalExpr(node.cond, env, ctx);
      if (typeof cond !== 'boolean') {
        throw new EvalError(`Condition must be a boolean, got ${typeName(cond)}`, node.cond.span, ctx.source);
      }
      return yield* evalExpr(cond ? node.then : node.otherwise, env, ctx);
    }
    case 'let': {
      const frame = new Frame(env);
      frame.cells.set(node.name, { kind: 'expr', node: node.value, env, state: 'pending' });
      return yield* evalExpr(node.body, frame, ctx);
    }
    case 'fn':
      return { params: node.params, body: node.body, env };
    case 'call': {
      const callee = yield* evalExpr(node.callee, env, ctx);
      if (!isClosure(callee)) {
        throw new EvalError(`Cannot call ${typeName(callee)}`, node.callee.span, ctx.source);
      }
      if (callee.params.length !== node.args.length) {
        throw new EvalError(
          `Arity mismatch: expected ${callee.params.length} argument(s), got ${node.args.length}`,
          node.span,
          ctx.source,
        );
      }
      const frame = new Frame(callee.env);
      callee.params.forEach((param, index) => {
        frame.cells.set(param, { kind: 'expr', node: node.args[index], env, state: 'pending' });
      });
      return yield* evalExpr(callee.body, frame, ctx);
    }
  }
}

function* evalBinary(
  node: Extract<Expr, { kind: 'binary' }>,
  env: Frame,
  ctx: Ctx,
): EvalGen<Value> {
  const op = node.op;
  if (op === '&&' || op === '||') {
    const left = yield* evalExpr(node.left, env, ctx);
    if (typeof left !== 'boolean') {
      throw new EvalError(`'${op}' expects boolean operands, got ${typeName(left)}`, node.left.span, ctx.source);
    }
    if (op === '&&' && !left) return false;
    if (op === '||' && left) return true;
    const right = yield* evalExpr(node.right, env, ctx);
    if (typeof right !== 'boolean') {
      throw new EvalError(`'${op}' expects boolean operands, got ${typeName(right)}`, node.right.span, ctx.source);
    }
    return right;
  }
  const left = yield* evalExpr(node.left, env, ctx);
  const right = yield* evalExpr(node.right, env, ctx);
  if (op === '==' || op === '!=') {
    if (typeof left !== typeof right || isClosure(left)) {
      throw new EvalError(`Cannot compare ${typeName(left)} with ${typeName(right)}`, node.span, ctx.source);
    }
    return op === '==' ? left === right : left !== right;
  }
  if (typeof left !== 'bigint' || typeof right !== 'bigint') {
    throw new EvalError(
      `'${op}' expects integer operands, got ${typeName(left)} and ${typeName(right)}`,
      node.span,
      ctx.source,
    );
  }
  switch (op) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      if (right === 0n) throw new EvalError('Division by zero', node.span, ctx.source);
      return left / right;
    case '%':
      if (right === 0n) throw new EvalError('Division by zero (modulo)', node.span, ctx.source);
      return left % right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    default:
      throw new Error(`Unreachable operator '${op}'`);
  }
}

function* evalProgram(program: Program, vars: Record<string, HostValue>): EvalGen<Value> {
  const ctx: Ctx = { source: program.source };
  const global = new Frame(null);
  for (const [name, value] of Object.entries(vars)) {
    global.cells.set(
      name,
      typeof value === 'function' ? { kind: 'host', run: value as () => Value, state: 'pending' } : value,
    );
  }
  const defFrame = new Frame(global);
  for (const def of program.defs) {
    defFrame.cells.set(def.name, { params: def.params, body: def.body, env: defFrame });
  }
  return yield* evalExpr(program.main, defFrame, ctx);
}

export interface EvalOptions {
  vars?: Record<string, HostValue>;
  budget?: number;
  pauseEvery?: number;
}

export type RunResult =
  | { status: 'done'; value: Value; steps: number }
  | { status: 'paused'; steps: number; resume: () => RunResult };

export function startEvaluation(program: Program, options: EvalOptions = {}): RunResult {
  return drive(evalProgram(program, options.vars ?? {}), options, 0);
}

function drive(gen: EvalGen<Value>, options: EvalOptions, steps: number): RunResult {
  for (;;) {
    const next = gen.next();
    if (next.done) return { status: 'done', value: next.value, steps };
    steps += 1;
    if (options.budget !== undefined && steps > options.budget) {
      throw new BudgetExhaustedError(options.budget);
    }
    if (options.pauseEvery !== undefined && options.pauseEvery > 0 && steps % options.pauseEvery === 0) {
      const savedSteps = steps;
      return { status: 'paused', steps: savedSteps, resume: () => drive(gen, options, savedSteps) };
    }
  }
}

export function evaluateProgram(program: Program, options: EvalOptions = {}): Value {
  let result = startEvaluation(program, options);
  while (result.status === 'paused') result = result.resume();
  return result.value;
}
