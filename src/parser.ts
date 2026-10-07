import type { BinOp, Def, Expr, Program } from './ast.ts';
import { ParseError } from './errors.ts';
import { lex, type Token } from './lexer.ts';

class Parser {
  private readonly tokens: Token[];
  private readonly source: string;
  private pos: number;

  constructor(tokens: Token[], source: string) {
    this.tokens = tokens;
    this.source = source;
    this.pos = 0;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(value: string): Token {
    const token = this.peek();
    if (token.type === 'eof' || token.value !== value) {
      throw new ParseError(
        `Expected '${value}' but found ${token.type === 'eof' ? 'end of input' : `'${token.value}'`}`,
        token.span,
        this.source,
      );
    }
    return this.advance();
  }

  private expectIdent(): string {
    const token = this.peek();
    if (token.type !== 'ident' || RESERVED.has(token.value)) {
      throw new ParseError(
        `Expected an identifier but found ${token.type === 'eof' ? 'end of input' : `'${token.value}'`}`,
        token.span,
        this.source,
      );
    }
    this.advance();
    return token.value;
  }

  parseProgram(): Program {
    const defs: Def[] = [];
    while (this.peek().type === 'ident' && this.peek().value === 'def') {
      defs.push(this.parseDef());
    }
    const main = this.parseExpr();
    const tail = this.peek();
    if (tail.type !== 'eof') {
      throw new ParseError(`Unexpected token '${tail.value}' after the main expression`, tail.span, this.source);
    }
    return { defs, main, source: this.source };
  }

  private parseDef(): Def {
    const start = this.expect('def');
    const name = this.expectIdent();
    this.expect('(');
    const params = this.parseParams();
    this.expect(')');
    this.expect('=');
    const body = this.parseExpr();
    const semi = this.expect(';');
    return { name, params, body, span: { start: start.span.start, end: semi.span.end } };
  }

  private parseParams(): string[] {
    const params: string[] = [];
    if (this.peek().value === ')') return params;
    params.push(this.expectIdent());
    while (this.peek().value === ',') {
      this.advance();
      params.push(this.expectIdent());
    }
    return params;
  }

  private parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const cond = this.parseOr();
    if (this.peek().value !== '?') return cond;
    this.advance();
    const then = this.parseTernary();
    this.expect(':');
    const otherwise = this.parseTernary();
    return { kind: 'cond', cond, then, otherwise, span: { start: cond.span.start, end: otherwise.span.end } };
  }

  private parseBinaryLevel(next: () => Expr, ops: string[]): Expr {
    let left = next();
    while (this.peek().type === 'op' && ops.includes(this.peek().value)) {
      const op = this.advance().value as BinOp;
      const right = next();
      left = { kind: 'binary', op, left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  private parseOr(): Expr {
    return this.parseBinaryLevel(() => this.parseAnd(), ['||']);
  }

  private parseAnd(): Expr {
    return this.parseBinaryLevel(() => this.parseEquality(), ['&&']);
  }

  private parseEquality(): Expr {
    return this.parseBinaryLevel(() => this.parseRelational(), ['==', '!=']);
  }

  private parseRelational(): Expr {
    return this.parseBinaryLevel(() => this.parseAdditive(), ['<', '<=', '>', '>=']);
  }

  private parseAdditive(): Expr {
    return this.parseBinaryLevel(() => this.parseMultiplicative(), ['+', '-']);
  }

  private parseMultiplicative(): Expr {
    return this.parseBinaryLevel(() => this.parseUnary(), ['*', '/', '%']);
  }

  private parseUnary(): Expr {
    const token = this.peek();
    if (token.type === 'op' && (token.value === '!' || token.value === '-')) {
      this.advance();
      const expr = this.parseUnary();
      return { kind: 'unary', op: token.value as '-' | '!', expr, span: { start: token.span.start, end: expr.span.end } };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (this.peek().type === 'op' && this.peek().value === '(') {
      this.advance();
      const args: Expr[] = [];
      if (this.peek().value !== ')') {
        args.push(this.parseExpr());
        while (this.peek().value === ',') {
          this.advance();
          args.push(this.parseExpr());
        }
      }
      const close = this.expect(')');
      expr = { kind: 'call', callee: expr, args, span: { start: expr.span.start, end: close.span.end } };
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const token = this.peek();
    if (token.type === 'num') {
      this.advance();
      return { kind: 'num', value: BigInt(token.value), span: token.span };
    }
    if (token.type === 'ident') {
      if (token.value === 'true' || token.value === 'false') {
        this.advance();
        return { kind: 'bool', value: token.value === 'true', span: token.span };
      }
      if (token.value === 'let') {
        const start = this.advance();
        const name = this.expectIdent();
        this.expect('=');
        const value = this.parseExpr();
        this.expect('in');
        const body = this.parseExpr();
        return { kind: 'let', name, value, body, span: { start: start.span.start, end: body.span.end } };
      }
      if (token.value === 'fn') {
        const start = this.advance();
        this.expect('(');
        const params = this.parseParams();
        this.expect(')');
        this.expect('=>');
        const body = this.parseExpr();
        return { kind: 'fn', params, body, span: { start: start.span.start, end: body.span.end } };
      }
      if (!RESERVED.has(token.value)) {
        this.advance();
        return { kind: 'var', name: token.value, span: token.span };
      }
    }
    if (token.type === 'op' && token.value === '(') {
      this.advance();
      const expr = this.parseExpr();
      this.expect(')');
      return expr;
    }
    throw new ParseError(
      `Unexpected ${token.type === 'eof' ? 'end of input' : `token '${token.value}'`}`,
      token.span,
      this.source,
    );
  }
}

const RESERVED = new Set(['def', 'in', 'true', 'false']);

export function parse(source: string): Program {
  return new Parser(lex(source), source).parseProgram();
}
