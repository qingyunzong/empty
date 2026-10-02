import { parseError } from './errors.js';

const BIN_BP = new Map([
  ['or', 1],
  ['and', 2],
  ['==', 3], ['!=', 3],
  ['<', 4], ['<=', 4], ['>', 4], ['>=', 4],
  ['+', 5], ['-', 5],
  ['*', 6], ['/', 6],
]);

const UNARY_BP = 7;

export function parse(tokens) {
  return new Parser(tokens).parsePlan();
}

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
  }

  peek() { return this.toks[this.pos]; }
  next() { return this.toks[this.pos++]; }

  fail(msg, tok) {
    const t = tok ?? this.peek();
    throw parseError(msg, { line: t.line, col: t.col });
  }

  isPunct(v) { const t = this.peek(); return t.type === 'punct' && t.value === v; }
  isKeyword(v) { const t = this.peek(); return t.type === 'keyword' && t.value === v; }

  expectPunct(v) {
    if (!this.isPunct(v)) this.fail(`expected '${v}', found ${this.peek().value ?? this.peek().type}`);
    return this.next();
  }

  expectKeyword(v) {
    if (!this.isKeyword(v)) this.fail(`expected '${v}'`);
    return this.next();
  }

  expectIdent() {
    const t = this.next();
    if (t.type !== 'ident') this.fail('expected identifier', t);
    return t.value;
  }

  parsePlan() {
    const params = [];
    const body = [];
    while (this.peek().type !== 'eof') {
      if (this.isKeyword('param')) params.push(this.parseParam());
      else body.push(this.parseStatement());
    }
    return { kind: 'Plan', params, body };
  }

  parseParam() {
    const kw = this.next();
    const name = this.expectIdent();
    this.expectPunct('=');
    const value = this.parseExpr(0);
    this.expectPunct(';');
    return { kind: 'Param', name, value, line: kw.line, col: kw.col };
  }

  parseStatement() {
    const t = this.peek();
    if (t.type === 'keyword') {
      switch (t.value) {
        case 'param': this.fail("'param' is only allowed at top level");
        case 'let': return this.parseLet();
        case 'revoke': return this.parseRevoke();
        case 'when': return this.parseWhen();
        case 'for': return this.parseFor();
        default: break;
      }
    }
    this.fail(`unexpected token ${JSON.stringify(t.value ?? t.type)}`);
    return null;
  }

  parseLet() {
    const kw = this.next();
    const name = this.expectIdent();
    this.expectPunct('=');
    const expr = this.parseExpr(0);
    this.expectPunct(';');
    return { kind: 'Let', name, expr, line: kw.line, col: kw.col };
  }

  parseRevoke() {
    const kw = this.next();
    const expr = this.parseExpr(0);
    this.expectPunct(';');
    return { kind: 'Revoke', expr, line: kw.line, col: kw.col };
  }

  parseWhen() {
    const kw = this.next();
    const cond = this.parseExpr(0);
    const body = this.parseBlock();
    return { kind: 'When', cond, body, line: kw.line, col: kw.col };
  }

  parseFor() {
    const kw = this.next();
    const name = this.expectIdent();
    this.expectKeyword('in');
    this.expectKeyword('txns');
    this.expectPunct('(');
    let list;
    if (this.isPunct('*')) {
      this.next();
      list = { kind: 'AllTxns' };
    } else {
      const ids = [];
      for (;;) {
        const t = this.next();
        if (t.type !== 'txn') this.fail('expected txn:<id> in txns(...) list', t);
        ids.push(t.value);
        if (this.isPunct(',')) { this.next(); continue; }
        break;
      }
      list = { kind: 'TxnList', ids };
    }
    this.expectPunct(')');
    const body = this.parseBlock();
    return { kind: 'For', name, list, body, line: kw.line, col: kw.col };
  }

  parseBlock() {
    this.expectPunct('{');
    const body = [];
    while (!this.isPunct('}')) {
      if (this.peek().type === 'eof') this.fail("unexpected end of input, expected '}'");
      body.push(this.parseStatement());
    }
    this.next();
    return body;
  }

  parseExpr(minBp) {
    let lhs = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      const op = (t.type === 'punct' || t.type === 'keyword') ? t.value : null;
      const bp = BIN_BP.get(op);
      if (bp == null || bp < minBp) break;
      this.next();
      const rhs = this.parseExpr(bp + 1);
      lhs = { kind: 'Binary', op, left: lhs, right: rhs, line: t.line, col: t.col };
    }
    return lhs;
  }

  parsePrefix() {
    const t = this.next();
    let node;
    if (t.type === 'keyword' && t.value === 'not') {
      node = { kind: 'Unary', op: 'not', expr: this.parseExpr(UNARY_BP), line: t.line, col: t.col };
    } else if (t.type === 'punct' && t.value === '-') {
      node = { kind: 'Unary', op: 'neg', expr: this.parseExpr(UNARY_BP), line: t.line, col: t.col };
    } else if (t.type === 'punct' && t.value === '(') {
      node = this.parseExpr(0);
      this.expectPunct(')');
    } else if (t.type === 'number') {
      node = t.isAmount
        ? { kind: 'Amount', value: t.value, line: t.line, col: t.col }
        : { kind: 'Number', value: t.value, line: t.line, col: t.col };
    } else if (t.type === 'string') {
      node = { kind: 'String', value: t.value, line: t.line, col: t.col };
    } else if (t.type === 'keyword' && (t.value === 'true' || t.value === 'false')) {
      node = { kind: 'Bool', value: t.value === 'true', line: t.line, col: t.col };
    } else if (t.type === 'status') {
      node = { kind: 'Status', value: t.value, line: t.line, col: t.col };
    } else if (t.type === 'txn') {
      node = { kind: 'Txn', value: t.value, line: t.line, col: t.col };
    } else if (t.type === 'acct') {
      node = { kind: 'Acct', value: t.value, line: t.line, col: t.col };
    } else if (t.type === 'ident') {
      node = { kind: 'Ident', name: t.value, line: t.line, col: t.col };
    } else {
      this.fail(`unexpected token ${JSON.stringify(t.value ?? t.type)}`, t);
    }
    while (this.isPunct('.')) {
      const dot = this.next();
      const field = this.next();
      if (field.type !== 'ident') this.fail('expected field name after "."', field);
      node = { kind: 'Field', obj: node, name: field.value, line: dot.line, col: dot.col };
    }
    return node;
  }
}
