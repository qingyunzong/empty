// Recursive-descent statements + Pratt parser for parameter expressions.
import { tokenize } from './lexer.js';

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

// binding powers: [left, right] for left-associative infix operators
const INFIX = new Map([
  ['+', [10, 11]],
  ['-', [10, 11]],
  ['*', [20, 21]],
  ['/', [20, 21]],
]);

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  atPunct(value) {
    const t = this.peek();
    return t.type === 'punct' && t.value === value;
  }

  expectPunct(value) {
    const t = this.next();
    if (t.type !== 'punct' || t.value !== value) {
      throw new ParseError(`expected '${value}' but found ${describe(t)} at ${t.line}:${t.col}`);
    }
    return t;
  }

  expectIdent() {
    const t = this.next();
    if (t.type !== 'ident') {
      throw new ParseError(`expected identifier but found ${describe(t)} at ${t.line}:${t.col}`);
    }
    return t.value;
  }

  atKeyword(word) {
    const t = this.peek();
    return t.type === 'ident' && t.value === word;
  }

  parseStatements(untilBrace) {
    const body = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') {
        if (untilBrace) throw new ParseError(`unexpected end of input, expected '}'`);
        return body;
      }
      if (this.atPunct('}')) {
        if (!untilBrace) throw new ParseError(`unexpected '}' at ${t.line}:${t.col}`);
        return body;
      }
      body.push(this.parseStatement());
    }
  }

  parseStatement() {
    const t = this.peek();
    if (t.type !== 'ident') {
      throw new ParseError(`expected statement but found ${describe(t)} at ${t.line}:${t.col}`);
    }
    if (t.value === 'experiment') {
      this.next();
      const name = this.expectIdent();
      this.expectPunct('{');
      const body = this.parseStatements(true);
      this.expectPunct('}');
      return { kind: 'experiment', name, body };
    }
    if (t.value === 'let' || t.value === 'override') {
      this.next();
      const name = this.expectIdent();
      this.expectPunct('=');
      const expr = this.parseExpr(0);
      this.expectPunct(';');
      return { kind: t.value, name, expr };
    }
    throw new ParseError(`unknown statement '${t.value}' at ${t.line}:${t.col}`);
  }

  // Pratt expression parser
  parseExpr(minBp) {
    const t = this.next();
    let left;
    if (t.type === 'number') {
      left = { kind: 'num', value: Number(t.value) };
    } else if (t.type === 'raw') {
      left = { kind: 'raw', value: t.value };
    } else if (t.type === 'ident') {
      left = { kind: 'ref', name: t.value };
    } else if (t.type === 'punct' && t.value === '(') {
      left = this.parseExpr(0);
      this.expectPunct(')');
    } else if (t.type === 'punct' && t.value === '-') {
      const operand = this.parseExpr(100);
      left = { kind: 'neg', expr: operand };
    } else {
      throw new ParseError(`expected expression but found ${describe(t)} at ${t.line}:${t.col}`);
    }
    for (;;) {
      const op = this.peek();
      if (op.type !== 'punct' || !INFIX.has(op.value)) return left;
      const [lBp, rBp] = INFIX.get(op.value);
      if (lBp < minBp) return left;
      this.next();
      const right = this.parseExpr(rBp);
      left = { kind: 'bin', op: op.value, left, right };
    }
  }
}

function describe(t) {
  if (t.type === 'eof') return 'end of input';
  return `'${t.value}'`;
}

export function parseProgram(source) {
  const parser = new Parser(tokenize(source));
  const body = parser.parseStatements(false);
  return { kind: 'program', body };
}

export function parseExpression(source) {
  const parser = new Parser(tokenize(source));
  const expr = parser.parseExpr(0);
  const t = parser.peek();
  if (t.type !== 'eof') {
    throw new ParseError(`unexpected trailing input ${describe(t)} at ${t.line}:${t.col}`);
  }
  return expr;
}

export function exprToString(expr) {
  switch (expr.kind) {
    case 'num':
      return String(expr.value);
    case 'raw':
      return '`' + expr.value + '`';
    case 'ref':
      return expr.name;
    case 'neg':
      return '-' + exprToString(expr.expr);
    case 'bin':
      return `(${exprToString(expr.left)} ${expr.op} ${exprToString(expr.right)})`;
    default:
      throw new ParseError(`unknown expr kind ${expr.kind}`);
  }
}
