import type { Program } from './ast.ts';
import {
  evaluateProgram,
  startEvaluation,
  type EvalOptions,
  type RunResult,
  type Value,
} from './evaluator.ts';
import { parse } from './parser.ts';

export function evaluate(source: string | Program, options: EvalOptions = {}): Value {
  const program = typeof source === 'string' ? parse(source) : source;
  return evaluateProgram(program, options);
}

export function start(source: string | Program, options: EvalOptions = {}): RunResult {
  const program = typeof source === 'string' ? parse(source) : source;
  return startEvaluation(program, options);
}

export { parse };
export { BudgetExhaustedError, EvalError, ExprError, ParseError, toRange } from './errors.ts';
export type { SourceRange } from './errors.ts';
export type { Def, Expr, Program, Span } from './ast.ts';
export type { Closure, EvalOptions, HostValue, RunResult, Value } from './evaluator.ts';
