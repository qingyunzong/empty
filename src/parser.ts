import { tokenize, Token } from "./lexer";
import { Node } from "./ast";

export class ParseError extends Error {
  constructor(message: string, readonly start: number, readonly end: number) {
    super(message);
    this.name = "ParseError";
  }
}

/**
 * Grammar (recursive descent):
 *   expr    := term (('+' | '-') term)*
 *   term    := juxt (('*' | '/') juxt)*
 *   juxt    := factor (implicit factor)*   // juxtaposition binds tighter than * and /
 *   factor  := unary ('^' unary)?
 *   unary   := '-' unary | primary
 *   primary := num | ident | '(' expr ')'
 * Implicit multiplication: a primary directly following a factor (e.g. "3 km", "2 (3+4)").
 */
export function parse(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;

  function parseExpr(): Node {
    let left = parseTerm();
    while (peek().kind === "op" && (peek().text === "+" || peek().text === "-")) {
      const op = next().text as "+" | "-";
      const right = parseTerm();
      left = { kind: "bin", op, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  function startsPrimary(t: Token): boolean {
    return t.kind === "num" || t.kind === "ident" || (t.kind === "op" && t.text === "(");
  }

  function parseTerm(): Node {
    let left = parseJuxt();
    while (peek().kind === "op" && (peek().text === "*" || peek().text === "/")) {
      const op = next().text as "*" | "/";
      const right = parseJuxt();
      left = { kind: "bin", op, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  function parseJuxt(): Node {
    let left = parseFactor();
    while (startsPrimary(peek())) {
      const right = parseFactor();
      left = { kind: "bin", op: "*", left, right, start: left.start, end: right.end };
    }
    return left;
  }

  function parseFactor(): Node {
    const base = parseUnary();
    const t = peek();
    if (t.kind === "op" && t.text === "^") {
      next();
      const exponent = parseUnary();
      return { kind: "pow", base, exponent, start: base.start, end: exponent.end };
    }
    return base;
  }

  function parseUnary(): Node {
    const t = peek();
    if (t.kind === "op" && t.text === "-") {
      next();
      const operand = parseUnary();
      return { kind: "neg", operand, start: t.start, end: operand.end };
    }
    return parsePrimary();
  }

  function parsePrimary(): Node {
    const t = next();
    if (t.kind === "num") return { kind: "num", raw: t.text, start: t.start, end: t.end };
    if (t.kind === "ident") return { kind: "unit", name: t.text, start: t.start, end: t.end };
    if (t.kind === "op" && t.text === "(") {
      const inner = parseExpr();
      const close = next();
      if (!(close.kind === "op" && close.text === ")")) {
        throw new ParseError("expected ')'", close.start, close.end);
      }
      return inner;
    }
    throw new ParseError(
      t.kind === "eof" ? "unexpected end of input" : `unexpected '${t.text}'`,
      t.start, t.end,
    );
  }

  const root = parseExpr();
  const last = peek();
  if (last.kind !== "eof") throw new ParseError(`unexpected '${last.text}'`, last.start, last.end);
  return root;
}
