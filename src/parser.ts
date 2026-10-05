import type { BinOp, Expr, FnDecl, Program, Span, UnOp } from './ast.js';
import { lex, type Token } from './lexer.js';

export class ParseError extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

const CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

function spanOf(left: Expr, right: Expr): Span {
  return { start: left.span.start, end: right.span.end };
}

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private peek(k = 0): Token {
    return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private atPunct(text: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.text === text;
  }

  private expectPunct(text: string): Token {
    const t = this.next();
    if (t.type !== 'punct' || t.text !== text) {
      throw new ParseError(`expected '${text}', got '${t.text || 'end of input'}'`, t.span);
    }
    return t;
  }

  parseProgram(): Program {
    const decls: FnDecl[] = [];
    while (
      this.peek().type === 'keyword' &&
      this.peek().text === 'fn' &&
      this.peek(1).type === 'ident'
    ) {
      decls.push(this.parseDecl());
    }
    const body = this.parseExpr();
    const eof = this.peek();
    if (eof.type !== 'eof') {
      throw new ParseError(`unexpected '${eof.text}' after expression`, eof.span);
    }
    return { decls, body };
  }

  private parseDecl(): FnDecl {
    const kw = this.next();
    const name = this.next();
    const params = this.parseParams();
    const body = this.parseBlock();
    return { name: name.text, params, body, span: { start: kw.span.start, end: body.span.end } };
  }

  private parseParams(): string[] {
    this.expectPunct('(');
    const params: string[] = [];
    if (!this.atPunct(')')) {
      for (;;) {
        const t = this.next();
        if (t.type !== 'ident') throw new ParseError('expected parameter name', t.span);
        params.push(t.text);
        if (this.atPunct(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expectPunct(')');
    return params;
  }

  private parseBlock(): Expr {
    this.expectPunct('{');
    const body = this.parseExpr();
    this.expectPunct('}');
    return body;
  }

  parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const cond = this.parseOr();
    if (!this.atPunct('?')) return cond;
    this.next();
    const thenExpr = this.parseTernary();
    this.expectPunct(':');
    const elseExpr = this.parseTernary();
    return {
      kind: 'if',
      cond,
      thenExpr,
      elseExpr,
      span: { start: cond.span.start, end: elseExpr.span.end },
    };
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.atPunct('||')) {
      this.next();
      const right = this.parseAnd();
      left = { kind: 'bin', op: '||', left, right, span: spanOf(left, right) };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseCmp();
    while (this.atPunct('&&')) {
      this.next();
      const right = this.parseCmp();
      left = { kind: 'bin', op: '&&', left, right, span: spanOf(left, right) };
    }
    return left;
  }

  private parseCmp(): Expr {
    let left = this.parseAdd();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'punct' || !CMP_OPS.has(t.text)) break;
      this.next();
      const right = this.parseAdd();
      left = { kind: 'bin', op: t.text as BinOp, left, right, span: spanOf(left, right) };
    }
    return left;
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'punct' || (t.text !== '+' && t.text !== '-')) break;
      this.next();
      const right = this.parseMul();
      left = { kind: 'bin', op: t.text as BinOp, left, right, span: spanOf(left, right) };
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'punct' || (t.text !== '*' && t.text !== '/' && t.text !== '%')) break;
      this.next();
      const right = this.parseUnary();
      left = { kind: 'bin', op: t.text as BinOp, left, right, span: spanOf(left, right) };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.type === 'punct' && (t.text === '-' || t.text === '!')) {
      this.next();
      const expr = this.parseUnary();
      return {
        kind: 'un',
        op: t.text as UnOp,
        expr,
        span: { start: t.span.start, end: expr.span.end },
      };
    }
    return this.parseCall();
  }

  private parseCall(): Expr {
    let expr = this.parsePrimary();
    while (this.atPunct('(')) {
      this.next();
      const args: Expr[] = [];
      if (!this.atPunct(')')) {
        for (;;) {
          args.push(this.parseExpr());
          if (this.atPunct(',')) {
            this.next();
            continue;
          }
          break;
        }
      }
      const close = this.expectPunct(')');
      expr = {
        kind: 'call',
        callee: expr,
        args,
        span: { start: expr.span.start, end: close.span.end },
      };
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.next();
    if (t.type === 'num') return { kind: 'num', value: BigInt(t.text), span: t.span };
    if (t.type === 'keyword' && t.text === 'true') {
      return { kind: 'bool', value: true, span: t.span };
    }
    if (t.type === 'keyword' && t.text === 'false') {
      return { kind: 'bool', value: false, span: t.span };
    }
    if (t.type === 'ident') return { kind: 'var', name: t.text, span: t.span };
    if (t.type === 'punct' && t.text === '(') {
      const e = this.parseExpr();
      this.expectPunct(')');
      return e;
    }
    if (t.type === 'keyword' && t.text === 'fn') {
      const params = this.parseParams();
      const body = this.parseBlock();
      return { kind: 'fn', params, body, span: { start: t.span.start, end: body.span.end } };
    }
    throw new ParseError(`unexpected '${t.text || 'end of input'}'`, t.span);
  }
}

export function parse(source: string): Program {
  const program = new Parser(lex(source)).parseProgram();
  program.source = source;
  return program;
}
