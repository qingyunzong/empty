import type { Expr, Program, Stmt, BinOp } from './ast.js';
import { tokenize, type Token } from './lexer.js';
import { ParseError } from './values.js';

/** Hard nesting cap: malicious deep input is rejected before evaluation. */
export const MAX_DEPTH = 200;

export function parse(src: string): Program {
  return new Parser(tokenize(src)).parseProgram();
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private atPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }
  private expectPunct(value: string): void {
    if (!this.atPunct(value)) {
      throw new ParseError(`expected '${value}' at ${this.peek().pos}`);
    }
    this.pos++;
  }

  parseProgram(): Program {
    const stmts: Stmt[] = [];
    while (this.peek().kind !== 'eof') stmts.push(this.parseStmt(0));
    return { stmts };
  }

  private parseStmt(depth: number): Stmt {
    if (depth > MAX_DEPTH) throw new ParseError('block nesting too deep');
    const t = this.peek();
    if (t.kind === 'punct') {
      switch (t.value) {
        case 'let': {
          this.next();
          const name = this.expectIdent();
          this.expectPunct('=');
          const init = this.parseExpr(0);
          this.expectPunct(';');
          return { tag: 'let', name, init };
        }
        case 'while': {
          this.next();
          this.expectPunct('(');
          const cond = this.parseExpr(0);
          this.expectPunct(')');
          return { tag: 'while', cond, body: this.parseBlock(depth + 1) };
        }
        case 'if': {
          this.next();
          this.expectPunct('(');
          const cond = this.parseExpr(0);
          this.expectPunct(')');
          const then = this.parseBlock(depth + 1);
          let elseBody: Stmt[] = [];
          if (this.atPunct('else')) {
            this.next();
            elseBody = this.parseBlock(depth + 1);
          }
          return { tag: 'if', cond, then, else: elseBody };
        }
        case 'set': {
          this.next();
          this.expectPunct('(');
          const key = this.parseExpr(0);
          this.expectPunct(',');
          const value = this.parseExpr(0);
          this.expectPunct(')');
          this.expectPunct(';');
          return { tag: 'set', key, value };
        }
        case 'return': {
          this.next();
          const value = this.parseExpr(0);
          this.expectPunct(';');
          return { tag: 'return', value };
        }
      }
    }
    if (t.kind === 'ident' && this.tokens[this.pos + 1]?.kind === 'punct'
        && (this.tokens[this.pos + 1] as { value: string }).value === '=') {
      const name = (this.next() as { name: string }).name;
      this.next(); // '='
      const value = this.parseExpr(0);
      this.expectPunct(';');
      return { tag: 'assign', name, value };
    }
    const expr = this.parseExpr(0);
    this.expectPunct(';');
    return { tag: 'expr', expr };
  }

  private parseBlock(depth: number): Stmt[] {
    this.expectPunct('{');
    const stmts: Stmt[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new ParseError('unclosed block');
      stmts.push(this.parseStmt(depth));
    }
    this.next();
    return stmts;
  }

  private expectIdent(): string {
    const t = this.next();
    if (t.kind !== 'ident') throw new ParseError(`expected identifier at ${t.pos}`);
    return t.name;
  }

  private parseExpr(depth: number): Expr {
    if (depth > MAX_DEPTH) throw new ParseError('expression nesting too deep');
    return this.parseBinary(0, depth);
  }

  private static LEVELS: BinOp[][] = [
    ['||'],
    ['&&'],
    ['<', '<=', '>', '>=', '==', '!='],
    ['+', '-'],
    ['*', '/', '%'],
  ];

  private parseBinary(level: number, depth: number): Expr {
    if (level >= Parser.LEVELS.length) return this.parseUnary(depth);
    let left = this.parseBinary(level + 1, depth);
    for (;;) {
      const t = this.peek();
      if (t.kind === 'punct' && (Parser.LEVELS[level] as string[]).includes(t.value)) {
        this.next();
        const right = this.parseBinary(level + 1, depth);
        left = { tag: 'binary', op: t.value as BinOp, left, right };
      } else {
        return left;
      }
    }
  }

  private parseUnary(depth: number): Expr {
    if (this.atPunct('-') || this.atPunct('!')) {
      const op = (this.next() as { value: '-' | '!' }).value;
      return { tag: 'unary', op, arg: this.parseUnary(depth) };
    }
    return this.parsePostfix(depth);
  }

  private parsePostfix(depth: number): Expr {
    let target = this.parsePrimary(depth);
    while (this.atPunct('[')) {
      this.next();
      const key = this.parseExpr(depth + 1);
      this.expectPunct(']');
      target = { tag: 'index', target, key };
    }
    return target;
  }

  private parsePrimary(depth: number): Expr {
    const t = this.next();
    switch (t.kind) {
      case 'num':
        return { tag: 'num', value: t.value };
      case 'str':
        return { tag: 'str', value: t.value };
      case 'ident':
        return { tag: 'var', name: t.name };
      case 'punct':
        switch (t.value) {
          case 'true':
            return { tag: 'bool', value: true };
          case 'false':
            return { tag: 'bool', value: false };
          case 'null':
            return { tag: 'null' };
          case 'len': {
            this.expectPunct('(');
            const arg = this.parseExpr(depth + 1);
            this.expectPunct(')');
            return { tag: 'len', arg };
          }
          case '(': {
            const inner = this.parseExpr(depth + 1);
            this.expectPunct(')');
            return inner;
          }
          case '[': {
            const items: Expr[] = [];
            if (!this.atPunct(']')) {
              for (;;) {
                items.push(this.parseExpr(depth + 1));
                if (this.atPunct(',')) { this.next(); continue; }
                break;
              }
            }
            this.expectPunct(']');
            return { tag: 'list', items };
          }
          case '{': {
            const entries: { key: string; value: Expr }[] = [];
            if (!this.atPunct('}')) {
              for (;;) {
                const k = this.next();
                if (k.kind !== 'str') throw new ParseError(`dict key must be a string at ${k.pos}`);
                this.expectPunct(':');
                entries.push({ key: k.value, value: this.parseExpr(depth + 1) });
                if (this.atPunct(',')) { this.next(); continue; }
                break;
              }
            }
            this.expectPunct('}');
            return { tag: 'dict', entries };
          }
        }
    }
    throw new ParseError(`unexpected token at ${t.pos}`);
  }
}
