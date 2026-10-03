import { tokenize } from './lexer.js';

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

const BIN_PREC = { '+': 10, '-': 10, '*': 20, '/': 20 };
const UNARY_PREC = 30;

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }

  next() { return this.tokens[this.pos++]; }

  expect(type) {
    const t = this.next();
    if (t.type !== type) {
      throw new ParseError(`expected '${type}' but found '${t.type}' at ${t.line}:${t.col}`);
    }
    return t;
  }

  parseProgram() {
    const body = [];
    while (this.peek().type !== 'eof' && this.peek().type !== '}') {
      body.push(this.parseStatement());
    }
    return body;
  }

  parseStatement() {
    const t = this.peek();
    if (t.type === 'ident' && t.value === 'experiment') {
      this.next();
      const name = this.expect('ident').value;
      this.expect('{');
      const body = this.parseProgram();
      this.expect('}');
      return { type: 'experiment', name, body };
    }
    if (t.type === 'ident' && (t.value === 'let' || t.value === 'override')) {
      const kind = this.next().value;
      const name = this.expect('ident').value;
      this.expect('=');
      const expr = this.parseExpr(0);
      this.expect(';');
      return { type: kind, name, expr };
    }
    throw new ParseError(`unexpected token '${t.type}' (${t.value ?? ''}) at ${t.line}:${t.col}`);
  }

  // Pratt parser: precedence climbing over binary operators.
  parseExpr(minPrec) {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      const prec = BIN_PREC[t.type];
      if (prec === undefined || prec < minPrec) return left;
      this.next();
      const right = this.parseExpr(prec + 1);
      left = { type: 'bin', op: t.type, left, right };
    }
  }

  parsePrefix() {
    const t = this.next();
    switch (t.type) {
      case 'number': return { type: 'num', value: t.value };
      case 'raw': return { type: 'raw', value: t.value };
      case 'ident': return { type: 'ref', name: t.value };
      case '-': return { type: 'neg', expr: this.parseExpr(UNARY_PREC) };
      case '(': {
        const inner = this.parseExpr(0);
        this.expect(')');
        return inner;
      }
      default:
        throw new ParseError(`unexpected token '${t.type}' in expression at ${t.line}:${t.col}`);
    }
  }
}

export function parse(source) {
  const parser = new Parser(tokenize(source));
  const body = parser.parseProgram();
  const tail = parser.peek();
  if (tail.type !== 'eof') {
    throw new ParseError(`unexpected '${tail.type}' at ${tail.line}:${tail.col}`);
  }
  return body;
}

// Parse a standalone expression (used by the `correct` command).
export function parseExpression(source) {
  const parser = new Parser(tokenize(source));
  const expr = parser.parseExpr(0);
  const tail = parser.peek();
  if (tail.type !== 'eof') {
    throw new ParseError(`trailing token '${tail.type}' after expression at ${tail.line}:${tail.col}`);
  }
  return expr;
}
