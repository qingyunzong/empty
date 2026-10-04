import { tokenize } from './lexer.js';

export class ParseError extends Error {
  constructor(message, token) {
    super(message);
    this.name = 'ParseError';
    this.line = token.line;
    this.col = token.col;
  }
}

const FUNCTIONS = new Set(['ancestors', 'descendants', 'shortestPath']);

const INFIX_BP = new Map([
  ['OR', 1],
  ['AND', 2],
  ['EQEQ', 3],
  ['NE', 3],
  ['LT', 3],
  ['LE', 3],
  ['GT', 3],
  ['GE', 3],
]);

function describe(token) {
  if (token.type === 'EOF') return 'end of input';
  return `'${token.value ?? token.type}'`;
}

class Parser {
  constructor(tokens, source) {
    this.tokens = tokens;
    this.source = source;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  expect(type, what) {
    const token = this.next();
    if (token.type !== type) {
      throw new ParseError(`expected ${what}, got ${describe(token)}`, token);
    }
    return token;
  }

  parseProgram() {
    const statements = [];
    while (this.peek().type !== 'EOF') statements.push(this.parseStatement());
    return { kind: 'program', statements };
  }

  parseStatement() {
    const token = this.peek();
    if (token.type === 'LET') return this.parseLet();
    if (token.type === 'QUERY') return this.parseQuery();
    throw new ParseError(`expected 'let' or 'query', got ${describe(token)}`, token);
  }

  parseLet() {
    const start = this.next();
    const name = this.expect('IDENT', 'a variable name');
    this.expect('EQ', "'='");
    const expr = this.parseExpr();
    const semi = this.expect('SEMI', "';'");
    return {
      kind: 'let',
      name: name.value,
      expr,
      line: start.line,
      source: this.source.slice(start.start, semi.end),
    };
  }

  parseQuery() {
    const start = this.next();
    const expr = this.parseExpr();
    let filter = null;
    if (this.peek().type === 'WHERE') {
      this.next();
      filter = this.parseFilter(1);
    }
    const semi = this.expect('SEMI', "';'");
    return {
      kind: 'query',
      expr,
      filter,
      line: start.line,
      source: this.source.slice(start.start, semi.end),
    };
  }

  parseExpr() {
    const token = this.next();
    switch (token.type) {
      case 'LOT':
        return { kind: 'literal', litKind: 'lot', value: token.value, line: token.line };
      case 'STRING':
        return { kind: 'literal', litKind: 'string', value: token.value, line: token.line };
      case 'DATE':
        return { kind: 'literal', litKind: 'date', value: token.value, line: token.line };
      case 'NUMBER':
        return { kind: 'literal', litKind: 'number', value: token.value, line: token.line };
      case 'TRUE':
        return { kind: 'literal', litKind: 'bool', value: true, line: token.line };
      case 'FALSE':
        return { kind: 'literal', litKind: 'bool', value: false, line: token.line };
      case 'IDENT': {
        if (this.peek().type === 'LPAREN') {
          if (!FUNCTIONS.has(token.value)) {
            throw new ParseError(`unknown function '${token.value}'`, token);
          }
          this.next();
          const args = [];
          if (this.peek().type !== 'RPAREN') {
            args.push(this.parseExpr());
            while (this.peek().type === 'COMMA') {
              this.next();
              args.push(this.parseExpr());
            }
          }
          this.expect('RPAREN', "')'");
          return { kind: 'call', fn: token.value, args, line: token.line };
        }
        return { kind: 'var', name: token.value, line: token.line };
      }
      default:
        throw new ParseError(`expected an expression, got ${describe(token)}`, token);
    }
  }

  parseFilter(minBp) {
    let left = this.parseFilterPrefix();
    for (;;) {
      const token = this.peek();
      const bp = INFIX_BP.get(token.type) ?? 0;
      if (bp === 0 || bp < minBp) break;
      this.next();
      const right = this.parseFilter(bp + 1);
      left = { kind: 'binary', op: token.type, left, right, line: token.line };
    }
    return left;
  }

  parseFilterPrefix() {
    const token = this.next();
    switch (token.type) {
      case 'NOT':
        return { kind: 'unary', op: 'NOT', operand: this.parseFilter(3), line: token.line };
      case 'LPAREN': {
        const inner = this.parseFilter(1);
        this.expect('RPAREN', "')'");
        return inner;
      }
      case 'IDENT':
        return { kind: 'name', name: token.value, line: token.line };
      case 'STRING':
        return { kind: 'literal', litKind: 'string', value: token.value, line: token.line };
      case 'DATE':
        return { kind: 'literal', litKind: 'date', value: token.value, line: token.line };
      case 'NUMBER':
        return { kind: 'literal', litKind: 'number', value: token.value, line: token.line };
      case 'LOT':
        return { kind: 'literal', litKind: 'lot', value: token.value, line: token.line };
      case 'TRUE':
        return { kind: 'literal', litKind: 'bool', value: true, line: token.line };
      case 'FALSE':
        return { kind: 'literal', litKind: 'bool', value: false, line: token.line };
      default:
        throw new ParseError(`expected a filter expression, got ${describe(token)}`, token);
    }
  }
}

export function parse(tokens, source) {
  return new Parser(tokens, source).parseProgram();
}

export function parseSource(source) {
  return parse(tokenize(source), source);
}
