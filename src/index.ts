export type { BinOp, Expr, FnDecl, Program, Span, UnOp } from './ast.js';
export { lex, LexError } from './lexer.js';
export type { Token, TokenType } from './lexer.js';
export { parse, ParseError } from './parser.js';
export {
  BudgetExceededError,
  Closure,
  Env,
  EvalError,
  Machine,
  Thunk,
} from './machine.js';
export type {
  Binding,
  Frame,
  MachineOptions,
  Snapshot,
  ThunkState,
  Value,
} from './machine.js';

import { parse } from './parser.js';
import { Machine, type MachineOptions, type Value } from './machine.js';

export function evaluate(source: string, options: MachineOptions = {}): Value {
  return new Machine(parse(source), options).run();
}

export function formatValue(v: Value): string {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '<function>';
}
