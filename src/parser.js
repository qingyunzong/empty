import { tokenize } from './lexer.js';

export class ParseError extends Error {
  constructor(message, line, column) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
    this.column = column;
  }
}

// Pratt binding powers for the filter (boolean) expression grammar.
const INFIX_BP = {
  or: [1, 2],
  and: [3, 4],
  '==': [5, 6], '!=': [5, 6],
  '<': [5, 6], '<=': [5, 6], '>': [5, 6], '>=': [5, 6],
};

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }

  fail(msg, tok = this.peek()) {
    throw new ParseError(msg, tok.line, tok.column);
  }

  expect(type, value) {
    const tok = this.next();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      this.fail(`expected ${value ?? type}, got ${tok.value ?? tok.type}`, tok);
    }
    return tok;
  }

  at(type, value) {
    const tok = this.peek();
    return tok.type === type && (value === undefined || tok.value === value);
  }

  eat(type, value) {
    if (this.at(type, value)) return this.next();
    return null;
  }

  parseProgram() {
    const body = this.parseStatements(() => this.at('EOF'));
    this.expect('EOF');
    return { type: 'program', body };
  }

  parseStatements(atEnd) {
    const body = [];
    while (!atEnd()) body.push(this.parseStatement());
    return body;
  }

  parseStatement() {
    const tok = this.peek();
    if (this.at('KEYWORD', 'let')) return this.parseLet();
    if (this.at('PUNCT', '{')) return this.parseBlock();
    return this.parseSelect();
  }

  parseLet() {
    const kw = this.expect('KEYWORD', 'let');
    const name = this.expect('IDENT').value;
    this.expect('OP', '=');
    const value = this.parseSource();
    this.expect('PUNCT', ';');
    return { type: 'let', name, value, line: kw.line };
  }

  parseBlock() {
    this.expect('PUNCT', '{');
    const body = this.parseStatements(() => this.at('PUNCT', '}'));
    this.expect('PUNCT', '}');
    this.eat('PUNCT', ';');
    return { type: 'block', body };
  }

  parseSelect() {
    const source = this.parseSource();
    let where = null;
    let orderBy = null;
    if (this.eat('KEYWORD', 'where')) where = this.parseExpr(0);
    if (this.eat('KEYWORD', 'order')) {
      this.expect('KEYWORD', 'by');
      const key = this.expect('IDENT').value;
      let dir = 'asc';
      if (this.eat('KEYWORD', 'desc')) dir = 'desc';
      else this.eat('KEYWORD', 'asc');
      orderBy = { key, dir };
    }
    this.expect('PUNCT', ';');
    return { type: 'select', source, where, orderBy, line: source.line };
  }

  parseSource() {
    const tok = this.peek();
    if (tok.type === 'KEYWORD' &&
        ['ancestors', 'descendants', 'shortestPath', 'nodes'].includes(tok.value)) {
      const name = this.next().value;
      this.expect('PUNCT', '(');
      const args = [];
      if (!this.at('PUNCT', ')')) {
        args.push(this.parseOperand());
        while (this.eat('PUNCT', ',')) args.push(this.parseOperand());
      }
      this.expect('PUNCT', ')');
      return { type: 'call', name, args, line: tok.line };
    }
    return this.parseOperand();
  }

  parseOperand() {
    const tok = this.next();
    if (tok.type === 'LOT') return { type: 'lot', value: tok.value, line: tok.line };
    if (tok.type === 'STRING') return { type: 'string', value: tok.value, line: tok.line };
    if (tok.type === 'IDENT') return { type: 'var', name: tok.value, line: tok.line };
    this.fail(`expected lot number, string or variable, got ${tok.value ?? tok.type}`, tok);
  }

  // Pratt parser for filter expressions.
  parseExpr(minBp) {
    let left = this.parsePrefix();
    for (;;) {
      const tok = this.peek();
      const op = tok.type === 'KEYWORD' && (tok.value === 'and' || tok.value === 'or')
        ? tok.value
        : tok.type === 'OP' && tok.value !== '=' ? tok.value : null;
      if (op === null || !(op in INFIX_BP)) break;
      const [lbp, rbp] = INFIX_BP[op];
      if (lbp < minBp) break;
      this.next();
      const right = this.parseExpr(rbp);
      left = { type: 'binary', op, left, right, line: tok.line };
    }
    return left;
  }

  parsePrefix() {
    const tok = this.next();
    if (tok.type === 'KEYWORD' && tok.value === 'not') {
      return { type: 'not', operand: this.parseExpr(7), line: tok.line };
    }
    if (tok.type === 'PUNCT' && tok.value === '(') {
      const inner = this.parseExpr(0);
      this.expect('PUNCT', ')');
      return inner;
    }
    if (tok.type === 'IDENT') return { type: 'prop', name: tok.value, line: tok.line };
    if (tok.type === 'STRING') return { type: 'const', value: tok.value, line: tok.line };
    if (tok.type === 'NUMBER') return { type: 'const', value: tok.value, line: tok.line };
    if (tok.type === 'DATE') return { type: 'const', value: tok.value, line: tok.line };
    if (tok.type === 'LOT') return { type: 'const', value: tok.value, line: tok.line };
    if (tok.type === 'KEYWORD' && tok.value === 'true') return { type: 'const', value: true, line: tok.line };
    if (tok.type === 'KEYWORD' && tok.value === 'false') return { type: 'const', value: false, line: tok.line };
    this.fail(`unexpected token ${tok.value ?? tok.type} in filter expression`, tok);
  }
}

export function parse(source) {
  return new Parser(tokenize(source)).parseProgram();
}
