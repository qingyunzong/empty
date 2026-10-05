import type { BinOp, Expr, Program, Span, UnOp } from './ast.js';

export type Value = bigint | boolean | Closure;

export class Closure {
  constructor(
    readonly params: string[],
    readonly body: Expr,
    readonly env: Env,
    readonly name: string | null = null,
  ) {}
}

export type Binding = Value | Thunk;

export class Env {
  private bindings = new Map<string, Binding>();

  constructor(readonly parent: Env | null = null) {}

  define(name: string, binding: Binding): void {
    this.bindings.set(name, binding);
  }

  lookup(name: string): Binding | undefined {
    let env: Env | null = this;
    while (env) {
      const binding = env.bindings.get(name);
      if (binding !== undefined) return binding;
      env = env.parent;
    }
    return undefined;
  }
}

export type ThunkState = 'pending' | 'value' | 'error';

export class Thunk {
  state: ThunkState = 'pending';
  value: Value | null = null;
  error: EvalError | null = null;

  constructor(
    readonly expr: Expr,
    readonly env: Env,
  ) {}
}

export class EvalError extends Error {
  constructor(
    message: string,
    readonly span: Span | null,
  ) {
    super(message);
    this.name = 'EvalError';
  }
}

export class BudgetExceededError extends EvalError {
  constructor(budget: number) {
    super(`step budget exhausted (${budget} steps)`, null);
    this.name = 'BudgetExceededError';
  }
}

export type Frame =
  | { tag: 'bin.right'; op: BinOp; right: Expr; env: Env; span: Span }
  | { tag: 'bin.apply'; op: BinOp; left: Value; span: Span }
  | { tag: 'un.apply'; op: UnOp; span: Span }
  | { tag: 'if.cond'; thenExpr: Expr; elseExpr: Expr; env: Env; span: Span }
  | { tag: 'call.args'; args: Expr[]; argEnv: Env; span: Span }
  | { tag: 'thunk.cache'; thunk: Thunk };

export interface Snapshot {
  node: Expr | null;
  value: Value | null;
  mode: 'eval' | 'return';
  stack: Frame[];
  env: Env;
  budget: number;
  done: boolean;
}

export interface MachineOptions {
  budget?: number;
  env?: Env;
}

const DEFAULT_BUDGET = 1_000_000;

function typeName(v: Value): string {
  if (typeof v === 'bigint') return 'integer';
  if (typeof v === 'boolean') return 'boolean';
  return 'function';
}

export class Machine {
  private node: Expr | null;
  private value: Value | null = null;
  private mode: 'eval' | 'return' = 'eval';
  private stack: Frame[] = [];
  private env: Env;
  private budget: number;
  private source?: string;

  done = false;
  stats = { steps: 0, thunkForces: 0 };
  thunks: Thunk[] = [];

  constructor(program: Program, options: MachineOptions = {}) {
    this.env = options.env ?? new Env();
    for (const decl of program.decls) {
      this.env.define(decl.name, new Closure(decl.params, decl.body, this.env, decl.name));
    }
    this.node = program.body;
    this.budget = options.budget ?? DEFAULT_BUDGET;
    this.source = program.source;
  }

  static restore(snapshot: Snapshot): Machine {
    const m = Object.create(Machine.prototype) as Machine;
    m.node = snapshot.node;
    m.value = snapshot.value;
    m.mode = snapshot.mode;
    m.stack = [...snapshot.stack];
    m.env = snapshot.env;
    m.budget = snapshot.budget;
    m.done = snapshot.done;
    m.stats = { steps: 0, thunkForces: 0 };
    m.thunks = [];
    m.source = undefined;
    return m;
  }

  pause(): Snapshot {
    return {
      node: this.node,
      value: this.value,
      mode: this.mode,
      stack: [...this.stack],
      env: this.env,
      budget: this.budget,
      done: this.done,
    };
  }

  run(): Value {
    while (!this.done) this.step();
    return this.value as Value;
  }

  step(): boolean {
    if (this.done) return false;
    try {
      if (this.budget <= 0) throw new BudgetExceededError(this.stats.steps);
      this.budget--;
      this.stats.steps++;
      if (this.mode === 'eval') this.evalNode();
      else this.deliver();
    } catch (e) {
      if (e instanceof EvalError) this.cacheThunkErrors(e);
      throw e;
    }
    return !this.done;
  }

  private cacheThunkErrors(error: EvalError): void {
    for (const frame of this.stack) {
      if (frame.tag === 'thunk.cache' && frame.thunk.state === 'pending') {
        frame.thunk.state = 'error';
        frame.thunk.error = error;
      }
    }
  }

  private fail(message: string, span: Span): never {
    throw new EvalError(this.withPosition(message, span), span);
  }

  private withPosition(message: string, span: Span): string {
    if (!this.source) return message;
    let line = 1;
    let col = 1;
    for (let i = 0; i < span.start && i < this.source.length; i++) {
      if (this.source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return `${message} at line ${line}, column ${col}`;
  }

  private needInt(v: Value, span: Span): bigint {
    if (typeof v !== 'bigint') this.fail(`type error: expected integer, got ${typeName(v)}`, span);
    return v as bigint;
  }

  private needBool(v: Value, span: Span): boolean {
    if (typeof v !== 'boolean') this.fail(`type error: expected boolean, got ${typeName(v)}`, span);
    return v as boolean;
  }

  private evalNode(): void {
    const node = this.node as Expr;
    switch (node.kind) {
      case 'num':
      case 'bool':
        this.value = node.value;
        this.mode = 'return';
        break;
      case 'var': {
        const binding = this.env.lookup(node.name);
        if (binding === undefined) this.fail(`undefined variable '${node.name}'`, node.span);
        if (binding instanceof Thunk) {
          if (binding.state === 'pending') {
            this.stats.thunkForces++;
            this.stack.push({ tag: 'thunk.cache', thunk: binding });
            this.env = binding.env;
            this.node = binding.expr;
          } else if (binding.state === 'value') {
            this.value = binding.value;
            this.mode = 'return';
          } else {
            throw binding.error as EvalError;
          }
        } else {
          this.value = binding;
          this.mode = 'return';
        }
        break;
      }
      case 'un':
        this.stack.push({ tag: 'un.apply', op: node.op, span: node.span });
        this.node = node.expr;
        break;
      case 'bin':
        this.stack.push({
          tag: 'bin.right',
          op: node.op,
          right: node.right,
          env: this.env,
          span: node.span,
        });
        this.node = node.left;
        break;
      case 'if':
        this.stack.push({
          tag: 'if.cond',
          thenExpr: node.thenExpr,
          elseExpr: node.elseExpr,
          env: this.env,
          span: node.span,
        });
        this.node = node.cond;
        break;
      case 'call':
        this.stack.push({ tag: 'call.args', args: node.args, argEnv: this.env, span: node.span });
        this.node = node.callee;
        break;
      case 'fn':
        this.value = new Closure(node.params, node.body, this.env);
        this.mode = 'return';
        break;
    }
  }

  private deliver(): void {
    const frame = this.stack.pop();
    if (!frame) {
      this.done = true;
      return;
    }
    switch (frame.tag) {
      case 'bin.right': {
        const left = this.value as Value;
        if (frame.op === '&&' || frame.op === '||') {
          const b = this.needBool(left, frame.span);
          if (frame.op === '&&' && !b) {
            this.value = false;
            break;
          }
          if (frame.op === '||' && b) {
            this.value = true;
            break;
          }
        }
        this.stack.push({ tag: 'bin.apply', op: frame.op, left, span: frame.span });
        this.node = frame.right;
        this.env = frame.env;
        this.mode = 'eval';
        break;
      }
      case 'bin.apply':
        this.value = this.applyBin(frame.op, frame.left, this.value as Value, frame.span);
        break;
      case 'un.apply':
        this.value =
          frame.op === '-'
            ? -this.needInt(this.value as Value, frame.span)
            : !this.needBool(this.value as Value, frame.span);
        break;
      case 'if.cond': {
        const cond = this.needBool(this.value as Value, frame.span);
        this.node = cond ? frame.thenExpr : frame.elseExpr;
        this.env = frame.env;
        this.mode = 'eval';
        break;
      }
      case 'call.args': {
        const callee = this.value as Value;
        if (!(callee instanceof Closure)) {
          this.fail(`cannot call ${typeName(callee)}`, frame.span);
        }
        const closure = callee as Closure;
        if (closure.params.length !== frame.args.length) {
          this.fail(
            `arity mismatch: expected ${closure.params.length} argument(s), got ${frame.args.length}`,
            frame.span,
          );
        }
        const callEnv = new Env(closure.env);
        for (let i = 0; i < closure.params.length; i++) {
          const thunk = new Thunk(frame.args[i], frame.argEnv);
          this.thunks.push(thunk);
          callEnv.define(closure.params[i], thunk);
        }
        this.env = callEnv;
        this.node = closure.body;
        this.mode = 'eval';
        break;
      }
      case 'thunk.cache':
        frame.thunk.state = 'value';
        frame.thunk.value = this.value;
        break;
    }
  }

  private applyBin(op: BinOp, l: Value, r: Value, span: Span): Value {
    switch (op) {
      case '+':
        return this.needInt(l, span) + this.needInt(r, span);
      case '-':
        return this.needInt(l, span) - this.needInt(r, span);
      case '*':
        return this.needInt(l, span) * this.needInt(r, span);
      case '/': {
        const a = this.needInt(l, span);
        const b = this.needInt(r, span);
        if (b === 0n) this.fail('division by zero', span);
        return a / b;
      }
      case '%': {
        const a = this.needInt(l, span);
        const b = this.needInt(r, span);
        if (b === 0n) this.fail('division by zero', span);
        return a % b;
      }
      case '<':
        return this.needInt(l, span) < this.needInt(r, span);
      case '<=':
        return this.needInt(l, span) <= this.needInt(r, span);
      case '>':
        return this.needInt(l, span) > this.needInt(r, span);
      case '>=':
        return this.needInt(l, span) >= this.needInt(r, span);
      case '==':
        return this.eq(l, r, span);
      case '!=':
        return !this.eq(l, r, span);
      case '&&':
        return this.needBool(l, span) && this.needBool(r, span);
      case '||':
        return this.needBool(l, span) || this.needBool(r, span);
    }
  }

  private eq(l: Value, r: Value, span: Span): boolean {
    if (l instanceof Closure || r instanceof Closure) {
      this.fail('cannot compare functions', span);
    }
    if (typeof l !== typeof r) {
      this.fail(`type error: cannot compare ${typeName(l)} with ${typeName(r)}`, span);
    }
    return l === r;
  }
}
