import { tokenize, type Token } from "./lexer.js";
import { SyntaxError_ } from "./errors.js";

export type BinaryOp =
  | "||" | "&&"
  | "<" | "<=" | ">" | ">=" | "==" | "!="
  | "+" | "-"
  | "*"
  | "**";

export type Node =
  | { kind: "num"; value: bigint; start: number; end: number }
  | { kind: "neg"; operand: Node; start: number; end: number }
  | { kind: "binary"; op: BinaryOp; left: Node; right: Node; start: number; end: number }
  | { kind: "cond"; cond: Node; then: Node; else: Node; start: number; end: number };

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private fail(message: string, token: Token): never {
    throw new SyntaxError_(message, { start: token.start, end: token.end }, this.source);
  }

  parse(): Node {
    const node = this.parseTernary();
    const tail = this.peek();
    if (tail.type !== "eof") this.fail("unexpected trailing input", tail);
    return node;
  }

  private parseTernary(): Node {
    const cond = this.parseBinary(0);
    if (this.peek().type !== "question") return cond;
    this.next();
    const then = this.parseTernary();
    const colon = this.next();
    if (colon.type !== "colon") this.fail("expected ':' in conditional", colon);
    const otherwise = this.parseTernary();
    return { kind: "cond", cond, then, else: otherwise, start: cond.start, end: otherwise.end };
  }

  private static readonly LEVELS: BinaryOp[][] = [
    ["||"],
    ["&&"],
    ["<", "<=", ">", ">=", "==", "!="],
    ["+", "-"],
    ["*"],
  ];

  private parseBinary(level: number): Node {
    if (level >= Parser.LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const token = this.peek();
      if (token.type !== "op" || !Parser.LEVELS[level]!.includes(token.value as BinaryOp)) {
        return left;
      }
      this.next();
      const right = this.parseBinary(level + 1);
      left = { kind: "binary", op: token.value as BinaryOp, left, right, start: left.start, end: right.end };
    }
  }

  private parseUnary(): Node {
    const token = this.peek();
    if (token.type === "op" && token.value === "-") {
      this.next();
      const operand = this.parseUnary();
      return { kind: "neg", operand, start: token.start, end: operand.end };
    }
    return this.parsePower();
  }

  private parsePower(): Node {
    const base = this.parsePrimary();
    const token = this.peek();
    if (token.type === "op" && token.value === "**") {
      this.next();
      // Right-associative; exponent may carry a unary minus (rejected at eval time).
      const exponent = this.parseUnary();
      return { kind: "binary", op: "**", left: base, right: exponent, start: base.start, end: exponent.end };
    }
    return base;
  }

  private parsePrimary(): Node {
    const token = this.next();
    if (token.type === "num") {
      return { kind: "num", value: BigInt(token.value), start: token.start, end: token.end };
    }
    if (token.type === "lparen") {
      const inner = this.parseTernary();
      const close = this.next();
      if (close.type !== "rparen") this.fail("expected ')'", close);
      // The parenthesized subexpression's range includes the parentheses.
      inner.start = token.start;
      inner.end = close.end;
      return inner;
    }
    this.fail("expected a number or '('", token);
  }
}

export function parse(source: string): Node {
  return new Parser(tokenize(source), source).parse();
}
