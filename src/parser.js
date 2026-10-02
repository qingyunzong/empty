'use strict';

const { tokenize } = require('./lexer');
const { QueryError } = require('./errors');

const CMP_OPS = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
const AGG_FNS = new Set(['count', 'sum', 'avg', 'min', 'max']);

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
  }

  peek() { return this.toks[this.pos]; }

  next() { return this.toks[this.pos++]; }

  expect(type, value) {
    const tok = this.next();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new QueryError(
        `expected ${value !== undefined ? `'${value}'` : type} but found ${describe(tok)}`,
        tok.pos,
      );
    }
    return tok;
  }

  isKw(word) {
    const tok = this.peek();
    return tok.type === 'kw' && tok.value === word;
  }

  parseProgram() {
    const lets = [];
    while (this.isKw('let')) {
      this.next();
      const nameTok = this.expect('ident');
      this.expect('op', '=');
      const expr = this.parseExpr(0);
      lets.push({ name: nameTok.value, expr });
    }
    let select = null;
    let where = null;
    if (this.isKw('select')) {
      this.next();
      select = this.parseAggregates();
    }
    if (this.isKw('where')) {
      this.next();
      where = this.parseExpr(0);
    } else if (select === null && this.peek().type !== 'eof') {
      where = this.parseExpr(0);
    }
    const tail = this.peek();
    if (tail.type !== 'eof') {
      throw new QueryError(`unexpected ${describe(tail)} after query`, tail.pos);
    }
    return { type: 'query', lets, select, where };
  }

  parseAggregates() {
    const list = [];
    for (;;) {
      const tok = this.next();
      if (tok.type !== 'kw' || !AGG_FNS.has(tok.value)) {
        throw new QueryError(`expected aggregate function but found ${describe(tok)}`, tok.pos);
      }
      this.expect('op', '(');
      if (tok.value === 'count') {
        this.expect('op', ')');
        list.push({ fn: 'count', field: null });
      } else {
        const fieldTok = this.expect('ident');
        this.expect('op', ')');
        list.push({ fn: tok.value, field: fieldTok.value });
      }
      const sep = this.peek();
      if (sep.type === 'op' && sep.value === ',') {
        this.next();
        continue;
      }
      break;
    }
    return list;
  }

  parseExpr(minPrec) {
    let left = this.parsePrefix();
    for (;;) {
      const tok = this.peek();
      let op = null;
      let prec = 0;
      if (tok.type === 'kw' && tok.value === 'or') { op = 'or'; prec = 1; }
      else if (tok.type === 'kw' && tok.value === 'and') { op = 'and'; prec = 2; }
      else if (tok.type === 'op' && CMP_OPS[tok.value]) { op = CMP_OPS[tok.value]; prec = 3; }
      else if (tok.type === 'kw' && tok.value === 'matches') { op = 'matches'; prec = 3; }
      if (!op || prec < minPrec) break;
      this.next();
      const right = this.parseExpr(prec + 1);
      left = op === 'and' || op === 'or'
        ? { type: 'logic', op, left, right }
        : { type: 'cmp', op, left, right };
    }
    return left;
  }

  parsePrefix() {
    if (this.isKw('not')) {
      this.next();
      return { type: 'not', operand: this.parseExpr(3) };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const tok = this.next();
    if (tok.type === 'op' && tok.value === '(') {
      const inner = this.parseExpr(0);
      this.expect('op', ')');
      return inner;
    }
    if (tok.type === 'num') return { type: 'lit', litType: 'number', value: tok.value };
    if (tok.type === 'str') return { type: 'lit', litType: 'string', value: tok.value };
    if (tok.type === 'time') return { type: 'lit', litType: 'time', value: tok.value };
    if (tok.type === 'kw' && (tok.value === 'true' || tok.value === 'false')) {
      return { type: 'lit', litType: 'boolean', value: tok.value === 'true' };
    }
    if (tok.type === 'ident') return { type: 'ref', name: tok.value };
    throw new QueryError(`unexpected ${describe(tok)}`, tok.pos);
  }
}

function describe(tok) {
  if (tok.type === 'eof') return 'end of input';
  return `'${tok.value}'`;
}

function parse(src) {
  return new Parser(tokenize(src)).parseProgram();
}

module.exports = { parse };
