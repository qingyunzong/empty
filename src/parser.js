'use strict';

const { JeError } = require('./errors');

const BIN_BP = { '+': 10, '-': 10, '*': 20, '/': 20 };

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
  }

  peek(k = 0) { return this.toks[this.pos + k]; }

  next() { return this.toks[this.pos++]; }

  at(t, v) {
    const tok = this.peek();
    return tok.t === t && (v === undefined || tok.v === v);
  }

  atKw(w) { return this.at('kw', w); }

  expect(t, v) {
    const tok = this.next();
    if (tok.t !== t || (v !== undefined && tok.v !== v)) {
      throw new JeError('E_PARSE', `expected ${v || t}, got '${tok.v}' at ${tok.line}:${tok.col}`);
    }
    return tok;
  }

  expectKw(w) { return this.expect('kw', w); }

  expectPunct(p) { return this.expect('punct', p); }

  parseProgram() {
    const decls = [];
    while (!this.at('eof')) {
      if (this.atKw('account')) decls.push(this.parseAccount());
      else if (this.atKw('period')) decls.push(this.parsePeriod());
      else if (this.atKw('template')) decls.push(this.parseTemplate());
      else if (this.atKw('batch')) decls.push(this.parseBatch());
      else {
        const tok = this.peek();
        throw new JeError('E_PARSE', `unexpected '${tok.v}' at ${tok.line}:${tok.col}`);
      }
    }
    return { kind: 'program', decls };
  }

  parseAccountCode() {
    const tok = this.next();
    if (tok.t === 'num') {
      if (tok.v.includes('.')) {
        throw new JeError('E_PARSE', `account code must be an integer, got '${tok.v}' at ${tok.line}:${tok.col}`);
      }
      return tok.v;
    }
    if (tok.t === 'ident') return tok.v;
    throw new JeError('E_PARSE', `expected account code, got '${tok.v}' at ${tok.line}:${tok.col}`);
  }

  parseAccount() {
    this.expectKw('account');
    const code = this.parseAccountCode();
    const name = this.expect('str').v;
    this.expectPunct(';');
    return { kind: 'account', code, name };
  }

  parsePeriodId() {
    const first = this.expect('num');
    if (first.v.includes('.')) {
      throw new JeError('E_PARSE', `bad period id '${first.v}' at ${first.line}:${first.col}`);
    }
    let id = first.v;
    while (this.at('punct', '-')) {
      this.next();
      const part = this.expect('num');
      if (part.v.includes('.')) {
        throw new JeError('E_PARSE', `bad period id at ${part.line}:${part.col}`);
      }
      id += '-' + part.v;
    }
    return id;
  }

  parsePeriod() {
    this.expectKw('period');
    const id = this.parsePeriodId();
    let state;
    if (this.atKw('open')) { this.next(); state = 'open'; }
    else if (this.atKw('closed')) { this.next(); state = 'closed'; }
    else {
      const tok = this.peek();
      throw new JeError('E_PARSE', `expected 'open' or 'closed', got '${tok.v}' at ${tok.line}:${tok.col}`);
    }
    this.expectPunct(';');
    return { kind: 'period', id, state };
  }

  parseTemplate() {
    this.expectKw('template');
    const name = this.expect('ident').v;
    this.expectPunct('(');
    const params = [];
    if (!this.at('punct', ')')) {
      params.push(this.expect('ident').v);
      while (this.at('punct', ',')) { this.next(); params.push(this.expect('ident').v); }
    }
    this.expectPunct(')');
    this.expectPunct('{');
    const body = [];
    while (!this.at('punct', '}')) {
      if (this.atKw('account')) body.push(this.parseAccount());
      else if (this.atKw('post')) body.push(this.parsePost());
      else {
        const tok = this.peek();
        throw new JeError('E_PARSE', `unexpected '${tok.v}' in template body at ${tok.line}:${tok.col}`);
      }
    }
    this.expectPunct('}');
    return { kind: 'template', name, params, body };
  }

  parseBatch() {
    this.expectKw('batch');
    const name = this.expect('ident').v;
    this.expectKw('in');
    const period = this.parsePeriodId();
    let on = null;
    if (this.atKw('on')) { this.next(); on = this.expect('ident').v; }
    this.expectPunct('{');
    const body = [];
    while (!this.at('punct', '}')) {
      if (this.atKw('post')) body.push(this.parsePost());
      else if (this.atKw('use')) body.push(this.parseUse());
      else if (this.atKw('balance')) body.push(this.parseBalance());
      else {
        const tok = this.peek();
        throw new JeError('E_PARSE', `unexpected '${tok.v}' in batch body at ${tok.line}:${tok.col}`);
      }
    }
    this.expectPunct('}');
    return { kind: 'batch', name, period, on, body };
  }

  parsePost() {
    this.expectKw('post');
    const legs = [];
    while (this.atKw('dr') || this.atKw('cr')) {
      const side = this.next().v;
      const account = this.parseAccountCode();
      const amount = this.parseExpr(0, { allowTotals: false });
      legs.push({ side, account, amount });
    }
    if (legs.length === 0) {
      const tok = this.peek();
      throw new JeError('E_PARSE', `post requires at least one leg at ${tok.line}:${tok.col}`);
    }
    this.expectPunct(';');
    return { kind: 'post', legs };
  }

  parseUse() {
    this.expectKw('use');
    const template = this.expect('ident').v;
    this.expectPunct('(');
    const args = [];
    if (!this.at('punct', ')')) {
      args.push(this.parseExpr(0, { allowTotals: false }));
      while (this.at('punct', ',')) { this.next(); args.push(this.parseExpr(0, { allowTotals: false })); }
    }
    this.expectPunct(')');
    this.expectPunct(';');
    return { kind: 'use', template, args };
  }

  parseBalance() {
    this.expectKw('balance');
    const left = this.parseExpr(0, { allowTotals: true });
    this.expectPunct('==');
    const right = this.parseExpr(0, { allowTotals: true });
    this.expectPunct(';');
    return { kind: 'balance', left, right };
  }

  parseExpr(minBp, opts) {
    let left = this.parsePrefix(opts);
    for (;;) {
      const tok = this.peek();
      if (tok.t !== 'punct' || !(tok.v in BIN_BP)) break;
      const bp = BIN_BP[tok.v];
      if (bp < minBp) break;
      this.next();
      const right = this.parseExpr(bp + 1, opts);
      left = { kind: 'bin', op: tok.v, l: left, r: right };
    }
    return left;
  }

  parsePrefix(opts) {
    const tok = this.next();
    if (tok.t === 'punct' && tok.v === '-') {
      return { kind: 'neg', e: this.parsePrefix(opts) };
    }
    if (tok.t === 'punct' && tok.v === '(') {
      const e = this.parseExpr(0, opts);
      this.expectPunct(')');
      return e;
    }
    if (tok.t === 'num') return { kind: 'num', raw: tok.v };
    if (tok.t === 'ident') return { kind: 'ref', name: tok.v };
    if (tok.t === 'kw' && tok.v === 'event') {
      this.expectPunct('.');
      const field = this.expect('ident').v;
      return { kind: 'event', field };
    }
    if (tok.t === 'kw' && (tok.v === 'dr' || tok.v === 'cr')) {
      if (!opts.allowTotals) {
        throw new JeError('E_PARSE', `'${tok.v}' total not allowed here at ${tok.line}:${tok.col}`);
      }
      if (this.at('punct', '(')) {
        this.next();
        const account = this.parseAccountCode();
        this.expectPunct(')');
        return { kind: 'total', side: tok.v, account };
      }
      return { kind: 'total', side: tok.v, account: null };
    }
    throw new JeError('E_PARSE', `unexpected '${tok.v}' at ${tok.line}:${tok.col}`);
  }
}

function parse(tokens) {
  return new Parser(tokens).parseProgram();
}

module.exports = { parse };
