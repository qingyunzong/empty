import type { Expr } from './ast.js';
import { type Context, type EvalResult } from './evaluate.js';
export { evaluate, type Context, type EvalResult, type Value } from './evaluate.js';
/** 解析并求值，一步完成。 */
export declare function run(source: string, ctx: Context): EvalResult;
export type { Expr };
