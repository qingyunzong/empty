import type { Expr } from './ast.js';
import { evaluate, type Context, type EvalResult } from './evaluate.js';
import { parse } from './parser.js';

export { evaluate, type Context, type EvalResult, type Value } from './evaluate.js';

/** 解析并求值，一步完成。 */
export function run(source: string, ctx: Context): EvalResult {
  return evaluate(parse(source), ctx);
}

export type { Expr };
