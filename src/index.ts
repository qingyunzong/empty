export { Rational } from "./rational.js";
export {
  DIM_KEYS,
  BASE_SYMBOLS,
  dimsZero,
  dimsOf,
  dimsAdd,
  dimsSub,
  dimsScale,
  dimsEqual,
  dimsIsZero,
  dimsToUnitString,
  type Dims,
  type DimKey,
} from "./dims.js";
export { lookupUnit, type UnitDef } from "./units.js";
export { tokenize, type Token, type TokenType } from "./lexer.js";
export { parse } from "./parser.js";
export { print } from "./print.js";
export { ParseError, CalcError, UnitError, type SideInfo } from "./errors.js";
export {
  evaluate,
  evaluateTyped,
  recheck,
  formatQuantity,
  quantityEqual,
  type Quantity,
  type TypedNode,
} from "./evaluate.js";
export type { Ast } from "./ast.js";

import { parse } from "./parser.js";
import { evaluate, formatQuantity, type Quantity } from "./evaluate.js";

/** Convenience: parse and evaluate a source string in one call. */
export function evaluateExpression(src: string): Quantity {
  return evaluate(parse(src));
}

/** Convenience: parse, evaluate, and render as "value canonical-unit". */
export function evaluateToString(src: string): string {
  return formatQuantity(evaluateExpression(src));
}
