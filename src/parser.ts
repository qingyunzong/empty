import type { Ast } from "./ast.js";
import { ParseError } from "./errors.js";
import { tokenize, type Token } from "./lexer.js";
import { Rational } from "./rational.js";
import { lookupUnit } from "./units.js";

/**
 * Grammar (precedence low to high):
 *   expr    := term (("+" | "-") term)*
 *   term    := group (("*" | "/") group)*
 *   group   := factor (implicit factor)*
 *   factor  := "-" factor | power
 *   power   := primary ("^" signed-integer)?
 *   primary := NUMBER | UNIT | "(" expr ")"
 * Implicit multiplication (juxtaposition: "3 m", "2(1+1)", "N m") binds
 * looser than explicit "*" and "/", so "10 m / 2 s" means (10 m)/(2 s).
 */
export function parse(src: string): Ast {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;

  function parseExpr(): Ast {
    let left = parseTerm();
    for (;;) {
      const t = peek();
      if (t.type !== "+" && t.type !== "-") return left;
      next();
      const right = parseTerm();
      left = { kind: "bin", op: t.type, left, right, start: left.start, end: right.end };
    }
  }

  function startsPrimary(t: Token): boolean {
    return t.type === "num" || t.type === "ident" || t.type === "(";
  }

  function parseTerm(): Ast {
    let left = parseGroup();
    for (;;) {
      const t = peek();
      if (t.type !== "*" && t.type !== "/") return left;
      next();
      const right = parseGroup();
      left = { kind: "bin", op: t.type, left, right, start: left.start, end: right.end };
    }
  }

  function parseGroup(): Ast {
    let left = parseFactor();
    for (;;) {
      const t = peek();
      if (!startsPrimary(t)) return left;
      const right = parseFactor();
      left = { kind: "bin", op: "*", left, right, start: left.start, end: right.end };
    }
  }

  function parseFactor(): Ast {
    const t = peek();
    if (t.type === "-") {
      next();
      const expr = parseFactor();
      return { kind: "neg", expr, start: t.start, end: expr.end };
    }
    return parsePower();
  }

  function parsePower(): Ast {
    const base = parsePrimary();
    const t = peek();
    if (t.type !== "^") return base;
    next();
    let sign = 1;
    if (peek().type === "-") {
      next();
      sign = -1;
    }
    const expTok = peek();
    if (expTok.type !== "num" || !/^\d+$/.test(expTok.text)) {
      throw new ParseError("expected a non-negative integer exponent", expTok.start, expTok.end);
    }
    next();
    const exp = sign * Number.parseInt(expTok.text, 10);
    if (Math.abs(exp) > 100) {
      throw new ParseError("exponent magnitude too large (max 100)", expTok.start, expTok.end);
    }
    return { kind: "pow", base, exp, start: base.start, end: expTok.end };
  }

  function parsePrimary(): Ast {
    const t = next();
    switch (t.type) {
      case "num":
        return { kind: "num", value: Rational.parse(t.text), start: t.start, end: t.end };
      case "ident": {
        const def = lookupUnit(t.text);
        if (def === undefined) {
          throw new ParseError(`unknown unit '${t.text}'`, t.start, t.end);
        }
        return { kind: "unit", name: t.text, def, start: t.start, end: t.end };
      }
      case "(": {
        const inner = parseExpr();
        const close = next();
        if (close.type !== ")") {
          throw new ParseError("expected ')'", close.start, close.end);
        }
        return { ...inner, start: t.start, end: close.end };
      }
      case "eof":
        throw new ParseError("unexpected end of input", t.start, t.end);
      default:
        throw new ParseError(`unexpected '${t.text}'`, t.start, t.end);
    }
  }

  const ast = parseExpr();
  const last = peek();
  if (last.type !== "eof") {
    throw new ParseError(`unexpected '${last.text}'`, last.start, last.end);
  }
  return ast;
}
