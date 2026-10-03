import { DslError, E_PARSE, E_SIGN } from './errors.js';
import { lexLine } from './lexer.js';
import { toScaled } from './expr.js';

const BINDING_POWER = { '+': 10, '-': 10, '*': 20, '/': 20, '%': 20 };
const EXPR_VARS = new Set(['qty', 'price', 'accrued']);

class Cursor {
  constructor(tokens, lineNo) {
    this.tokens = tokens;
    this.i = 0;
    this.lineNo = lineNo;
  }
  peek() { return this.tokens[this.i]; }
  next() { return this.tokens[this.i++]; }
  err(msg, tok = this.peek()) {
    return new DslError(E_PARSE, `line ${this.lineNo}: ${msg}`, { line: this.lineNo, col: tok.col });
  }
  expect(t, what) {
    const tok = this.next();
    if (tok.t !== t) throw this.err(`expected ${what ?? t}, got ${tok.t} '${tok.v}'`, tok);
    return tok;
  }
  expectKw(word) {
    const tok = this.next();
    if (tok.t !== 'kw' || tok.v !== word) {
      throw this.err(`expected '${word}', got '${tok.v}'`, tok);
    }
    return tok;
  }
  atEnd() { return this.peek().t === 'eof'; }

  // Pratt parser: nud handles literals/vars/parens/unary minus,
  // led folds binary operators by binding power.
  parseExpr(minBp = 0) {
    const tok = this.next();
    let left;
    if (tok.t === 'num') {
      left = { k: 'num', v: toScaled(tok.v, { line: this.lineNo, col: tok.col }) };
    } else if (tok.t === 'kw' && EXPR_VARS.has(tok.v)) {
      left = { k: 'var', name: tok.v };
    } else if (tok.t === 'lp') {
      left = this.parseExpr(0);
      this.expect('rp', "')'");
    } else if (tok.t === 'op' && tok.v === '-') {
      left = { k: 'neg', e: this.parseExpr(30) };
    } else {
      throw this.err(`unexpected token '${tok.v}' in expression`, tok);
    }
    for (;;) {
      const next = this.peek();
      if (next.t !== 'op') break;
      const bp = BINDING_POWER[next.v];
      if (bp === undefined || bp < minBp) break;
      this.next();
      const right = this.parseExpr(bp + 1);
      left = { k: 'bin', op: next.v, l: left, r: right };
    }
    return left;
  }
}

function parseQty(cursor) {
  let neg = false;
  if (cursor.peek().t === 'op' && cursor.peek().v === '-') { cursor.next(); neg = true; }
  const tok = cursor.expect('num', 'quantity');
  if (tok.v.includes('.')) throw cursor.err('quantity must be an integer', tok);
  const qty = BigInt(tok.v);
  if (neg || qty <= 0n) {
    throw new DslError(E_SIGN, `quantity must be positive, got ${tok.v}`,
      { line: cursor.lineNo, col: tok.col });
  }
  return qty;
}

function parseTradeLike(kind, cursor, lineNo, src) {
  const id = cursor.expect('id', 'trade id').v;
  const version = cursor.expect('ver', 'version (e.g. v2)').v;
  const date = cursor.expect('date', 'trade date').v;
  const dirTok = cursor.expect('kw', "'buy' or 'sell'");
  if (dirTok.v !== 'buy' && dirTok.v !== 'sell') {
    throw cursor.err(`expected 'buy' or 'sell', got '${dirTok.v}'`, dirTok);
  }
  const qty = parseQty(cursor);
  const isin = cursor.expect('id', 'ISIN').v;
  cursor.expect('at', "'@'");
  const priceExpr = cursor.parseExpr(0);
  const modeTok = cursor.expect('kw', "'net' or 'gross'");
  if (modeTok.v !== 'net' && modeTok.v !== 'gross') {
    throw cursor.err(`expected 'net' or 'gross', got '${modeTok.v}'`, modeTok);
  }
  let accrued = 0n;
  let feeExpr = null;
  while (!cursor.atEnd()) {
    const kw = cursor.next();
    if (kw.t === 'kw' && kw.v === 'accrued') {
      const n = cursor.expect('num', 'accrued amount');
      accrued = toScaled(n.v, { line: lineNo, col: n.col });
    } else if (kw.t === 'kw' && kw.v === 'fee') {
      feeExpr = cursor.parseExpr(0);
    } else {
      throw cursor.err(`unexpected '${kw.v}', want 'accrued' or 'fee'`, kw);
    }
  }
  return { kind, id, version, date, dir: dirTok.v, qty, isin,
    priceExpr, priceMode: modeTok.v, accrued, feeExpr, src, line: lineNo };
}

function parseCancel(cursor, lineNo, src) {
  const id = cursor.expect('id', 'trade id').v;
  const version = cursor.expect('ver', 'version (e.g. v2)').v;
  const date = cursor.expect('date', 'trade date').v;
  if (!cursor.atEnd()) throw cursor.err('trailing tokens after cancel');
  return { kind: 'cancel', id, version, date, src, line: lineNo };
}

function parseDeposit(cursor, lineNo, src) {
  const date = cursor.expect('date', 'value date').v;
  const isin = cursor.expect('id', 'ISIN').v;
  let qty = 0n;
  let cash = 0n;
  let seen = 0;
  while (!cursor.atEnd()) {
    const kw = cursor.next();
    const n = cursor.expect('num', 'amount');
    if (kw.t === 'kw' && kw.v === 'qty') {
      if (n.v.includes('.')) throw cursor.err('qty must be an integer', n);
      qty = BigInt(n.v);
    } else if (kw.t === 'kw' && kw.v === 'cash') {
      cash = toScaled(n.v, { line: lineNo, col: n.col });
    } else {
      throw cursor.err(`expected 'qty' or 'cash', got '${kw.v}'`, kw);
    }
    seen += 1;
  }
  if (seen === 0) throw cursor.err('deposit needs qty and/or cash');
  if (qty < 0n || cash < 0n) {
    throw new DslError(E_SIGN, 'deposit amounts must be non-negative', { line: lineNo });
  }
  return { kind: 'deposit', date, isin, qty, cash, src, line: lineNo };
}

export function parseLine(text, lineNo = 1) {
  const tokens = lexLine(text, lineNo);
  const cursor = new Cursor(tokens, lineNo);
  const head = cursor.peek();
  if (head.t === 'eof') return null;
  if (head.t !== 'kw') throw cursor.err(`expected keyword, got '${head.v}'`, head);
  const src = text.trim().replace(/\s+/g, ' ');
  switch (head.v) {
    case 'trade': cursor.next(); return parseTradeLike('trade', cursor, lineNo, src);
    case 'amend': cursor.next(); return parseTradeLike('amend', cursor, lineNo, src);
    case 'cancel': cursor.next(); return parseCancel(cursor, lineNo, src);
    case 'deposit': cursor.next(); return parseDeposit(cursor, lineNo, src);
    default: throw cursor.err(`unknown event keyword '${head.v}'`, head);
  }
}

export function parseSource(text) {
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const ev = parseLine(lines[i], i + 1);
    if (ev) events.push(ev);
  }
  return events;
}
