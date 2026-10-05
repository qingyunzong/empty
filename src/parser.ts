import type { BinaryOp, Node, Range } from './ast.ts';
import { ParseError } from './errors.ts';

/**
 * Grammar (precedence low -> high):
 *   ternary := logicOr ('?' ternary ':' ternary)?
 *   logicOr := logicAnd ('||' logicAnd)*
 *   logicAnd:= equality ('&&' equality)*
 *   equality:= comparison (('=='|'!=') comparison)*
 *   comparison := additive (('<'|'<='|'>'|'>=') additive)*
 *   additive := multiplicative (('+'|'-') multiplicative)*
 *   multiplicative := unary ('*' unary)*
 *   unary    := '-' unary | power
 *   power    := primary ('^' unary)?        (right associative)
 *   primary  := INT | '(' ternary ')'
 */

type Token =
  | { kind: 'num'; value: bigint; range: Range }
  | { kind: 'op'; op: string; range: Range }
  | { kind: 'eof'; range: Range };

const OPERATORS = ['||', '&&', '==', '!=', '<=', '>=', '+', '-', '*', '^', '<', '>', '(', ')', '?', ':'];

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < source.length && source[j] >= '0' && source[j] <= '9') j++;
      tokens.push({ kind: 'num', value: BigInt(source.slice(i, j)), range: { start: i, end: j } });
      i = j;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (op !== undefined) {
      tokens.push({ kind: 'op', op, range: { start: i, end: i + op.length } });
      i += op.length;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`, i);
  }
  tokens.push({ kind: 'eof', range: { start: source.length, end: source.length } });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private eatOp(op: string): Token | undefined {
    const token = this.peek();
    if (token.kind === 'op' && token.op === op) {
      this.pos++;
      return token;
    }
    return undefined;
  }

  private expectOp(op: string): Token {
    const token = this.eatOp(op);
    if (token === undefined) {
      const here = this.peek();
      throw new ParseError(`expected '${op}'`, here.range.start);
    }
    return token;
  }

  parseExpression(): Node {
    const node = this.parseTernary();
    const tail = this.peek();
    if (tail.kind !== 'eof') {
      throw new ParseError('unexpected trailing input', tail.range.start);
    }
    return node;
  }

  private parseTernary(): Node {
    const cond = this.parseBinaryLevel(0);
    const q = this.eatOp('?');
    if (q === undefined) return cond;
    const then = this.parseTernary();
    this.expectOp(':');
    const otherwise = this.parseTernary();
    return { kind: 'cond', cond, then, otherwise, range: { start: cond.range.start, end: otherwise.range.end } };
  }

  private static readonly LEVELS: BinaryOp[][] = [
    ['||'],
    ['&&'],
    ['==', '!='],
    ['<', '<=', '>', '>='],
    ['+', '-'],
    ['*'],
  ];

  private parseBinaryLevel(level: number): Node {
    if (level >= Parser.LEVELS.length) return this.parseUnary();
    const ops = Parser.LEVELS[level];
    let left = this.parseBinaryLevel(level + 1);
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'op' || !ops.includes(token.op as BinaryOp)) return left;
      this.next();
      const right = this.parseBinaryLevel(level + 1);
      left = {
        kind: 'bin',
        op: token.op as BinaryOp,
        left,
        right,
        range: { start: left.range.start, end: right.range.end },
      };
    }
  }

  private parseUnary(): Node {
    const minus = this.eatOp('-');
    if (minus !== undefined) {
      const operand = this.parseUnary();
      return { kind: 'neg', operand, range: { start: minus.range.start, end: operand.range.end } };
    }
    return this.parsePower();
  }

  private parsePower(): Node {
    const base = this.parsePrimary();
    const caret = this.eatOp('^');
    if (caret === undefined) return base;
    const exponent = this.parseUnary();
    return { kind: 'bin', op: '^', left: base, right: exponent, range: { start: base.range.start, end: exponent.range.end } };
  }

  private parsePrimary(): Node {
    const token = this.next();
    if (token.kind === 'num') {
      return { kind: 'num', value: token.value, range: token.range };
    }
    if (token.kind === 'op' && token.op === '(') {
      const inner = this.parseTernary();
      const close = this.expectOp(')');
      inner.range = { start: token.range.start, end: close.range.end };
      return inner;
    }
    throw new ParseError(`expected a number or '('`, token.range.start);
  }
}

export function parse(source: string): Node {
  return new Parser(lex(source), source).parseExpression();
}
