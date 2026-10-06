import { Node, CompareOp } from "./ast.js";
import { RuleSyntaxError } from "./errors.js";
import { tokenize, Token, TokenType } from "./lexer.js";

const COMPARE_OPS: Partial<Record<TokenType, CompareOp>> = {
  eq: "==",
  ne: "!=",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
};

const TOKEN_NAMES: Record<TokenType, string> = {
  ident: "identifier",
  number: "number",
  string: "string",
  boolean: "boolean",
  null: "null",
  and: "&&",
  or: "||",
  not: "!",
  eq: "==",
  ne: "!=",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
  lparen: "(",
  rparen: ")",
  eof: "end of input",
};

/**
 * Grammar (lowest to highest precedence):
 *   orExpr     := andExpr ( "||" andExpr )*
 *   andExpr    := unaryExpr ( "&&" unaryExpr )*
 *   unaryExpr  := "!" unaryExpr | comparison
 *   comparison := primary ( compareOp primary )?
 *   primary    := "(" orExpr ")" | literal | field
 */
export function parseRule(source: string): Node {
  const tokens = tokenize(source);
  let cursor = 0;

  const peek = (): Token => tokens[cursor];
  const next = (): Token => tokens[cursor++];
  const unexpected = (t: Token): RuleSyntaxError =>
    new RuleSyntaxError(`unexpected ${TOKEN_NAMES[t.type]}`, t.pos);

  const parseOr = (): Node => {
    let left = parseAnd();
    while (peek().type === "or") {
      const op = next();
      left = { kind: "Or", left, right: parseAnd(), pos: op.pos };
    }
    return left;
  };

  const parseAnd = (): Node => {
    let left = parseUnary();
    while (peek().type === "and") {
      const op = next();
      left = { kind: "And", left, right: parseUnary(), pos: op.pos };
    }
    return left;
  };

  const parseUnary = (): Node => {
    if (peek().type === "not") {
      const op = next();
      return { kind: "Not", operand: parseUnary(), pos: op.pos };
    }
    return parseComparison();
  };

  const parseComparison = (): Node => {
    const left = parsePrimary();
    const op = COMPARE_OPS[peek().type];
    if (op === undefined) return left;
    const opToken = next();
    const right = parsePrimary();
    if (COMPARE_OPS[peek().type] !== undefined) {
      throw new RuleSyntaxError(
        "chained comparisons are not allowed; use '&&' or parentheses",
        peek().pos
      );
    }
    return { kind: "Compare", op, left, right, pos: opToken.pos };
  };

  const parsePrimary = (): Node => {
    const t = next();
    switch (t.type) {
      case "number":
        return { kind: "Number", value: t.value as bigint, pos: t.pos };
      case "string":
        return { kind: "String", value: t.value as string, pos: t.pos };
      case "boolean":
        return { kind: "Boolean", value: t.value as boolean, pos: t.pos };
      case "null":
        return { kind: "Null", pos: t.pos };
      case "ident":
        return { kind: "Field", name: t.value as string, pos: t.pos };
      case "lparen": {
        const inner = parseOr();
        if (peek().type !== "rparen") {
          throw new RuleSyntaxError("expected ')'", peek().pos);
        }
        next();
        return inner;
      }
      default:
        throw unexpected(t);
    }
  };

  const ast = parseOr();
  if (peek().type !== "eof") throw unexpected(peek());
  return ast;
}
