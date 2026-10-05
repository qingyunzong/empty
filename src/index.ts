export type { BinaryOp, Node, Range } from './ast.ts';
export { parse } from './parser.ts';
export { ParseError, EvalError, BudgetError } from './errors.ts';
export { digitCount } from './digits.ts';
export {
  evaluate,
  evaluateAst,
  DEFAULT_MAX_DIGITS,
  DEFAULT_MAX_STEPS,
  type EvalOptions,
  type EvalOutcome,
} from './evaluator.ts';
export { evaluateExact, interpretAst } from './interpreter.ts';
