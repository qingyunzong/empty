import { Expr, Stmt, BinaryOp } from './ast';
import { ParseError } from './errors';
import { tokenize, Token } from './lexer';

const KEYWORDS = new Set(['let', 'if', 'else', 'while', 'transaction', 'rollback', 'break', 'continue', 'true', 'false']);

export const DEFAULT_MAX_DEPTH = 200;

export function parse(source: string, maxDepth = DEFAULT_MAX_DEPTH): Stmt[] {
  return new Parser(tokenize(source), maxDepth).parseProgram();
}

class Parser {
  private pos = 0;

  constructor(private tokens: Token[], private maxDepth: number) {}

  private peek(): Token { return this.tokens[this.pos]; }

  private next(): Token { return this.tokens[this.pos++]; }

  private fail(message: string, tok: Token = this.peek()): never {
    throw new ParseError(message, tok.line, tok.col);
  }

  private atPunct(value: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === value;
  }

  private eatPunct(value: string): boolean {
    if (this.atPunct(value)) { this.pos++; return true; }
    return false;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) this.fail(`expected '${value}'`);
  }

  private atKeyword(word: string): boolean {
    const t = this.peek();
    return t.type === 'ident' && t.value === word;
  }

  private expectIdent(): string {
    const t = this.next();
    if (t.type !== 'ident' || KEYWORDS.has(t.value)) this.fail('expected identifier', t);
    return t.value;
  }

  private enter(depth: number): void {
    if (depth > this.maxDepth) this.fail(`nesting deeper than ${this.maxDepth} levels`);
  }

  parseProgram(): Stmt[] {
    const stmts = this.parseStmts(0, () => this.peek().type === 'eof');
    if (this.peek().type !== 'eof') this.fail('unexpected token');
    return stmts;
  }

  private parseBlock(depth: number): Stmt[] {
    this.expectPunct('{');
    const body = this.parseStmts(depth + 1, () => this.atPunct('}'));
    this.expectPunct('}');
    return body;
  }

  private parseStmts(depth: number, atEnd: () => boolean): Stmt[] {
    this.enter(depth);
    const stmts: Stmt[] = [];
    while (!atEnd()) stmts.push(this.parseStmt(depth));
    return stmts;
  }

  private parseStmt(depth: number): Stmt {
    if (this.atKeyword('let')) {
      this.next();
      const name = this.expectIdent();
      this.expectPunct('=');
      const value = this.parseExpr(depth + 1);
      this.expectPunct(';');
      return { kind: 'let', name, value };
    }
    if (this.atKeyword('if')) {
      this.next();
      this.expectPunct('(');
      const cond = this.parseExpr(depth + 1);
      this.expectPunct(')');
      const then = this.parseBlock(depth);
      let elseBody: Stmt[] = [];
      if (this.atKeyword('else')) {
        this.next();
        elseBody = this.parseBlock(depth);
      }
      return { kind: 'if', cond, then, else: elseBody };
    }
    if (this.atKeyword('while')) {
      this.next();
      this.expectPunct('(');
      const cond = this.parseExpr(depth + 1);
      this.expectPunct(')');
      const body = this.parseBlock(depth);
      return { kind: 'while', cond, body };
    }
    if (this.atKeyword('transaction')) {
      this.next();
      return { kind: 'transaction', body: this.parseBlock(depth) };
    }
    if (this.atKeyword('rollback')) { this.next(); this.expectPunct(';'); return { kind: 'rollback' }; }
    if (this.atKeyword('break')) { this.next(); this.expectPunct(';'); return { kind: 'break' }; }
    if (this.atKeyword('continue')) { this.next(); this.expectPunct(';'); return { kind: 'continue' }; }

    const expr = this.parseExpr(depth + 1);
    if (this.eatPunct('=')) {
      if (!this.isLValue(expr)) this.fail('left side of = must be a variable or index path');
      const value = this.parseExpr(depth + 1);
      this.expectPunct(';');
      return { kind: 'assign', target: expr, value };
    }
    this.expectPunct(';');
    return { kind: 'expr', expr };
  }

  private isLValue(expr: Expr): boolean {
    let cur: Expr = expr;
    while (cur.kind === 'index') cur = cur.target;
    return cur.kind === 'var';
  }

  private parseExpr(depth: number): Expr {
    this.enter(depth);
    return this.parseBinary(depth, 0);
  }

  private static readonly LEVELS: BinaryOp[][] = [
    ['||'],
    ['&&'],
    ['==', '!='],
    ['<', '<=', '>', '>='],
    ['+', '-'],
    ['*', '/', '%'],
  ];

  private parseBinary(depth: number, level: number): Expr {
    if (level >= Parser.LEVELS.length) return this.parseUnary(depth);
    let left = this.parseBinary(depth, level + 1);
    for (;;) {
      const t = this.peek();
      const ops = Parser.LEVELS[level];
      if (t.type === 'punct' && (ops as string[]).includes(t.value)) {
        this.next();
        const right = this.parseBinary(depth, level + 1);
        left = { kind: 'binary', op: t.value as BinaryOp, left, right };
      } else {
        return left;
      }
    }
  }

  private parseUnary(depth: number): Expr {
    if (this.atPunct('-') || this.atPunct('!')) {
      const op = this.next().value as '-' | '!';
      return { kind: 'unary', op, operand: this.parseUnary(depth) };
    }
    return this.parsePostfix(depth);
  }

  private parsePostfix(depth: number): Expr {
    let expr = this.parsePrimary(depth);
    while (this.atPunct('[')) {
      this.next();
      const index = this.parseExpr(depth + 1);
      this.expectPunct(']');
      expr = { kind: 'index', target: expr, index };
    }
    return expr;
  }

  private parsePrimary(depth: number): Expr {
    const t = this.next();
    if (t.type === 'int') {
      const value = Number(t.value);
      if (!Number.isSafeInteger(value)) this.fail('integer literal out of range', t);
      return { kind: 'int', value };
    }
    if (t.type === 'str') return { kind: 'str', value: t.value };
    if (t.type === 'ident') {
      if (t.value === 'true') return { kind: 'int', value: 1 };
      if (t.value === 'false') return { kind: 'int', value: 0 };
      if (KEYWORDS.has(t.value)) this.fail(`unexpected keyword '${t.value}'`, t);
      return { kind: 'var', name: t.value };
    }
    if (t.type === 'punct' && t.value === '(') {
      const inner = this.parseExpr(depth + 1);
      this.expectPunct(')');
      return inner;
    }
    if (t.type === 'punct' && t.value === '[') {
      const items: Expr[] = [];
      if (!this.atPunct(']')) {
        for (;;) {
          items.push(this.parseExpr(depth + 1));
          if (!this.eatPunct(',')) break;
        }
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.type === 'punct' && t.value === '{') {
      const entries: Array<{ key: string; value: Expr }> = [];
      if (!this.atPunct('}')) {
        for (;;) {
          const keyTok = this.next();
          if (keyTok.type !== 'str') this.fail('dict keys must be string literals', keyTok);
          this.expectPunct(':');
          entries.push({ key: keyTok.value, value: this.parseExpr(depth + 1) });
          if (!this.eatPunct(',')) break;
        }
      }
      this.expectPunct('}');
      return { kind: 'dict', entries };
    }
    this.fail('expected expression', t);
  }
}
