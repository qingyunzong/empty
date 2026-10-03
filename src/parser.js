import { CorpError, E_SYNTAX, E_DATE, E_RATIO } from './errors.js';

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  let maxDay = DAYS_IN_MONTH[month - 1];
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    maxDay = leap ? 29 : 28;
  }
  return day >= 1 && day <= maxDay;
}

function syntax(msg, line) {
  return new CorpError(E_SYNTAX, `${msg} at line ${line}`);
}

// Pratt parser for ratio / cash expressions.
// Precedence: unary - > * / > + -
const BIN_PREC = { '+': 10, '-': 10, '*': 20, '/': 20 };

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
  }

  peek() { return this.toks[this.pos]; }

  next() { return this.toks[this.pos++]; }

  expect(t, what) {
    const tok = this.next();
    if (tok.t !== t) {
      throw syntax(`expected ${what || t} but found ${tok.t} ${JSON.stringify(tok.v)}`, tok.line);
    }
    return tok;
  }

  expectKeyword(word) {
    const tok = this.next();
    if (tok.t !== 'IDENT' || tok.v !== word) {
      throw syntax(`expected keyword '${word}' but found ${tok.t} ${JSON.stringify(tok.v)}`, tok.line);
    }
    return tok;
  }

  parseProgram() {
    const stmts = [];
    while (this.peek().t !== 'EOF') stmts.push(this.parseStatement());
    return stmts;
  }

  parseStatement() {
    const tok = this.peek();
    if (tok.t === 'IDENT') {
      switch (tok.v) {
        case 'action': return this.parseAction('APPLY');
        case 'restated': return this.parseAction('RESTATED');
        case 'reverse': return this.parseReverse();
        case 'sell': return this.parseSell();
        default: break;
      }
    }
    throw syntax(`expected statement (action|restated|reverse|sell) but found ${tok.t} ${JSON.stringify(tok.v)}`, tok.line);
  }

  // action <id>: <SEC> <kind> ex <date> v<n>
  // restated <id>: <SEC> <kind> ex <date> v<n>
  parseAction(type) {
    const kw = this.next();
    const id = this.expect('IDENT', 'action id').v;
    this.expect(':');
    const sec = this.expect('IDENT', 'security symbol').v;
    const action = this.parseActionKind(kw.line);
    this.expectKeyword('ex');
    const ex = this.parseDate();
    const version = this.parseVersion();
    return { type, id, sec, action, ex, version, line: kw.line };
  }

  parseActionKind(line) {
    const kw = this.expect('IDENT', 'action kind (split|dividend|tender)').v;
    if (kw === 'split') {
      return { kind: 'split', ratio: this.parseExpr() };
    }
    if (kw === 'dividend') {
      return { kind: 'dividend', amount: this.parseExpr() };
    }
    if (kw === 'tender') {
      const price = this.parseExpr();
      this.expectKeyword('for');
      const fraction = this.parseExpr();
      return { kind: 'tender', price, fraction };
    }
    throw syntax(`unknown action kind '${kw}' (expected split|dividend|tender)`, line);
  }

  // reverse <id> ex <date> v<n>
  parseReverse() {
    const kw = this.next();
    const id = this.expect('IDENT', 'action id').v;
    this.expectKeyword('ex');
    const ex = this.parseDate();
    const version = this.parseVersion();
    return { type: 'REVERSE', id, ex, version, line: kw.line };
  }

  // sell <SEC> <qty-expr> on <date>
  parseSell() {
    const kw = this.next();
    const sec = this.expect('IDENT', 'security symbol').v;
    const qty = this.parseExpr();
    this.expectKeyword('on');
    const date = this.parseDate();
    return { type: 'SELL', sec, qty, date, line: kw.line };
  }

  parseDate() {
    const tok = this.expect('DATE', 'ex-date (YYYY-MM-DD)');
    if (!isValidDate(tok.v)) {
      throw new CorpError(E_DATE, `invalid calendar date '${tok.v}' at line ${tok.line}`);
    }
    return tok.v;
  }

  parseVersion() {
    const tok = this.next();
    let version = null;
    if (tok.t === 'IDENT' && tok.v === 'v') {
      const n = this.expect('NUM', 'announcement version');
      version = n.v;
    } else if (tok.t === 'IDENT' && /^v\d+$/.test(tok.v)) {
      version = Number(tok.v.slice(1));
    } else {
      throw syntax(`expected announcement version (v<n>) but found ${tok.t} ${JSON.stringify(tok.v)}`, tok.line);
    }
    if (!Number.isInteger(version) || version < 0) {
      throw new CorpError(E_RATIO, `announcement version must be a non-negative integer, got ${version}`);
    }
    return version;
  }

  parseExpr(minPrec = 0) {
    let left = this.parsePrefix();
    for (;;) {
      const tok = this.peek();
      const prec = BIN_PREC[tok.t] || 0;
      if (prec === 0 || prec < minPrec) break;
      this.next();
      const right = this.parseExpr(prec + 1);
      left = { kind: 'bin', op: tok.t, left, right };
    }
    return left;
  }

  parsePrefix() {
    const tok = this.next();
    if (tok.t === 'NUM') return { kind: 'num', value: tok.v };
    if (tok.t === 'CASH') return { kind: 'cash', value: tok.v };
    if (tok.t === '-') {
      const expr = this.parseExpr(30);
      return { kind: 'neg', expr };
    }
    if (tok.t === '(') {
      const expr = this.parseExpr();
      this.expect(')');
      return expr;
    }
    throw syntax(`expected expression but found ${tok.t} ${JSON.stringify(tok.v)}`, tok.line);
  }
}

export function parse(tokens) {
  return new Parser(tokens).parseProgram();
}
