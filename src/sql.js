'use strict';

// SQL subset:
//   SELECT select_list FROM t [a] [JOIN t [a] ON expr]*
//   [WHERE expr] [GROUP BY cols] [HAVING expr]
// Expressions: literals, col refs, = <> != < <= > >=, AND/OR/NOT,
// IS [NOT] NULL, + - * /, parentheses, COUNT/SUM/AVG/MIN/MAX.
const { E_PARSE, E_UNSUPPORTED } = require('./errors');

const AGG_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'JOIN', 'INNER', 'ON',
  'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'TRUE', 'FALSE',
  'DISTINCT', 'ORDER', 'LIMIT', 'OFFSET', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
  'CROSS', 'UNION', 'INTERSECT', 'EXCEPT', 'IN', 'BETWEEN', 'LIKE', 'CASE',
  'ASC', 'DESC', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
]);

function tokenize(src) {
  const toks = [];
  let i = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      const n = Number(text);
      if (text.split('.').length > 2 || Number.isNaN(n)) throw E_PARSE(`bad number literal '${text}'`);
      toks.push({ t: 'num', v: n });
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length) throw E_PARSE('unterminated string literal');
        if (src[j] === "'") {
          if (src[j + 1] === "'") { s += "'"; j += 2; continue; }
          j++;
          break;
        }
        s += src[j++];
      }
      toks.push({ t: 'str', v: s });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '<>', '!='].includes(two)) {
      toks.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('=<>+-*/(),.'.includes(c)) {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw E_PARSE(`unexpected character '${c}'`);
  }
  toks.push({ t: 'eof' });
  return toks;
}

class Parser {
  constructor(toks) {
    this.toks = toks;
    this.i = 0;
  }
  peek() { return this.toks[this.i]; }
  ahead(k) { return this.toks[this.i + k] || { t: 'eof' }; }
  isKw(kw) {
    const x = this.peek();
    return x.t === 'ident' && x.v.toUpperCase() === kw;
  }
  eatKw(kw) {
    if (this.isKw(kw)) { this.i++; return true; }
    return false;
  }
  expectKw(kw) {
    if (!this.eatKw(kw)) throw E_PARSE(`expected ${kw}, found '${this.peek().v ?? this.peek().t}'`);
  }
  isOp(o) {
    const x = this.peek();
    return x.t === 'op' && x.v === o;
  }
  eatOp(o) {
    if (this.isOp(o)) { this.i++; return true; }
    return false;
  }
  expectOp(o) {
    if (!this.eatOp(o)) throw E_PARSE(`expected '${o}', found '${this.peek().v ?? this.peek().t}'`);
  }
  expectIdent() {
    const x = this.peek();
    if (x.t !== 'ident') throw E_PARSE(`expected identifier, found '${x.v ?? x.t}'`);
    this.i++;
    return x.v;
  }

  parseQuery() {
    this.expectKw('SELECT');
    if (this.isKw('DISTINCT')) throw E_UNSUPPORTED('DISTINCT is not supported');
    const select = this.parseSelectList();
    this.expectKw('FROM');
    const from = this.parseFrom();
    let where = null;
    let groupBy = [];
    let having = null;
    if (this.eatKw('WHERE')) where = this.parseExpr();
    if (this.eatKw('GROUP')) {
      this.expectKw('BY');
      groupBy = this.parseExprList();
    }
    if (this.eatKw('HAVING')) having = this.parseExpr();
    for (const kw of ['ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT']) {
      if (this.isKw(kw)) throw E_UNSUPPORTED(`${kw} is not supported`);
    }
    if (this.peek().t !== 'eof') throw E_PARSE(`unexpected token '${this.peek().v}'`);
    return { select, from, where, groupBy, having };
  }

  parseSelectList() {
    const items = [];
    for (;;) {
      if (this.eatOp('*')) {
        items.push({ star: true });
      } else {
        const expr = this.parseExpr();
        let alias = null;
        if (this.eatKw('AS')) {
          alias = this.expectIdent();
        } else if (this.peek().t === 'ident' && !KEYWORDS.has(this.peek().v.toUpperCase())) {
          alias = this.peek().v;
          this.i++;
        }
        items.push({ expr, alias });
      }
      if (!this.eatOp(',')) break;
    }
    return items;
  }

  parseFrom() {
    const base = this.parseTableRef();
    const joins = [];
    for (;;) {
      if (this.isKw('LEFT') || this.isKw('RIGHT') || this.isKw('FULL') || this.isKw('CROSS')) {
        throw E_UNSUPPORTED('only INNER JOIN is supported');
      }
      this.eatKw('INNER');
      if (!this.eatKw('JOIN')) break;
      const ref = this.parseTableRef();
      this.expectKw('ON');
      const on = this.parseExpr();
      joins.push({ ...ref, on });
    }
    return { base, joins };
  }

  parseTableRef() {
    if (this.isOp('(')) throw E_UNSUPPORTED('subqueries are not supported');
    const table = this.expectIdent();
    let alias = null;
    if (this.eatKw('AS')) {
      alias = this.expectIdent();
    } else if (this.peek().t === 'ident' && !KEYWORDS.has(this.peek().v.toUpperCase())) {
      alias = this.peek().v;
      this.i++;
    }
    return { table, alias };
  }

  parseExprList() {
    const list = [this.parseExpr()];
    while (this.eatOp(',')) list.push(this.parseExpr());
    return list;
  }

  parseExpr() {
    let e = this.parseAnd();
    while (this.eatKw('OR')) e = { t: 'bin', op: 'OR', l: e, r: this.parseAnd() };
    return e;
  }

  parseAnd() {
    let e = this.parseNot();
    while (this.eatKw('AND')) e = { t: 'bin', op: 'AND', l: e, r: this.parseNot() };
    return e;
  }

  parseNot() {
    if (this.eatKw('NOT')) return { t: 'not', e: this.parseNot() };
    return this.parsePred();
  }

  parsePred() {
    const l = this.parseAdd();
    const x = this.peek();
    if (x.t === 'op' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(x.v)) {
      this.i++;
      const r = this.parseAdd();
      return { t: 'bin', op: x.v, l, r };
    }
    if (this.eatKw('IS')) {
      const negated = this.eatKw('NOT');
      this.expectKw('NULL');
      return { t: 'isnull', e: l, negated };
    }
    if (this.isKw('IN') || this.isKw('BETWEEN') || this.isKw('LIKE')) {
      throw E_UNSUPPORTED('only comparison and IS NULL predicates are supported');
    }
    return l;
  }

  parseAdd() {
    let e = this.parseMul();
    for (;;) {
      if (this.eatOp('+')) e = { t: 'bin', op: '+', l: e, r: this.parseMul() };
      else if (this.eatOp('-')) e = { t: 'bin', op: '-', l: e, r: this.parseMul() };
      else break;
    }
    return e;
  }

  parseMul() {
    let e = this.parseUnary();
    for (;;) {
      if (this.eatOp('*')) e = { t: 'bin', op: '*', l: e, r: this.parseUnary() };
      else if (this.eatOp('/')) e = { t: 'bin', op: '/', l: e, r: this.parseUnary() };
      else break;
    }
    return e;
  }

  parseUnary() {
    if (this.eatOp('-')) return { t: 'neg', e: this.parseUnary() };
    return this.parsePrimary();
  }

  parsePrimary() {
    const x = this.peek();
    if (x.t === 'num') { this.i++; return { t: 'lit', value: x.v }; }
    if (x.t === 'str') { this.i++; return { t: 'lit', value: x.v }; }
    if (this.eatKw('NULL')) return { t: 'lit', value: null };
    if (this.eatKw('TRUE')) return { t: 'lit', value: true };
    if (this.eatKw('FALSE')) return { t: 'lit', value: false };
    if (this.eatOp('(')) {
      const e = this.parseExpr();
      this.expectOp(')');
      return e;
    }
    if (x.t === 'ident') {
      const upper = x.v.toUpperCase();
      if (AGG_FUNCS.has(upper) && this.ahead(1).t === 'op' && this.ahead(1).v === '(') {
        this.i++;
        this.expectOp('(');
        if (this.eatOp('*')) {
          if (upper !== 'COUNT') throw E_PARSE(`${upper}(*) is not allowed`);
          this.expectOp(')');
          return { t: 'agg', func: upper, arg: null };
        }
        const arg = this.parseExpr();
        this.expectOp(')');
        return { t: 'agg', func: upper, arg };
      }
      if (this.ahead(1).t === 'op' && this.ahead(1).v === '(') {
        throw E_UNSUPPORTED(`function ${x.v} is not supported`);
      }
      this.i++;
      if (this.eatOp('.')) {
        const name = this.expectIdent();
        return { t: 'col', table: x.v, name };
      }
      return { t: 'col', table: null, name: x.v };
    }
    throw E_PARSE(`unexpected token '${x.v ?? x.t}'`);
  }
}

function parse(src) {
  return new Parser(tokenize(src)).parseQuery();
}

module.exports = { parse, tokenize };
