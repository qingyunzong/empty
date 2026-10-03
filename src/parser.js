import { lex } from './lexer.js';
import { LimError, E_TYPE } from './errors.js';

// Binding powers for the Pratt (precedence-climbing) expression parser.
const BIN_BP = {
  '||': 1, 'or': 1,
  '&&': 2, 'and': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};
const PREFIX_BP = 7;

function normOp(op) {
  if (op === 'and') return '&&';
  if (op === 'or') return '||';
  return op;
}

class Reader {
  constructor(tokens) { this.toks = tokens; this.i = 0; }
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  fail(msg, tok = this.peek()) {
    throw new LimError(E_TYPE, `parse error at ${tok.line}:${tok.col}: ${msg}`);
  }
  expectSym(v) {
    const t = this.next();
    if (t.t !== 'sym' || t.v !== v) this.fail(`expected '${v}', got '${t.v}'`, t);
    return t;
  }
  expectKw(v) {
    const t = this.next();
    if (t.t !== 'kw' || t.v !== v) this.fail(`expected keyword '${v}', got '${t.v}'`, t);
    return t;
  }
  expectIdent() {
    const t = this.next();
    if (t.t !== 'ident') this.fail(`expected identifier, got '${t.v}'`, t);
    return t.v;
  }
  expectNum() {
    const t = this.next();
    if (t.t !== 'num') this.fail(`expected number, got '${t.v}'`, t);
    return t.v;
  }
}

// Pratt parser: nud (prefix) + led (infix with binding power).
export function parseExpr(r, minBp = 0) {
  const t = r.next();
  let lhs;
  if (t.t === 'num') lhs = { k: 'num', v: t.v };
  else if (t.t === 'kw' && t.v === 'true') lhs = { k: 'num', v: 1 };
  else if (t.t === 'kw' && t.v === 'false') lhs = { k: 'num', v: 0 };
  else if (t.t === 'sym' && t.v === '(') { lhs = parseExpr(r, 0); r.expectSym(')'); }
  else if (t.t === 'sym' && t.v === '-') lhs = { k: 'un', op: 'neg', e: parseExpr(r, PREFIX_BP) };
  else if ((t.t === 'sym' && t.v === '!') || (t.t === 'kw' && t.v === 'not')) {
    lhs = { k: 'un', op: 'not', e: parseExpr(r, PREFIX_BP) };
  } else if (t.t === 'ident' || t.t === 'kw') {
    if (t.t === 'kw' && (t.v === 'and' || t.v === 'or')) r.fail(`unexpected operator '${t.v}'`, t);
    const path = [t.v];
    while (r.peek().t === 'sym' && r.peek().v === '.') {
      r.next();
      const p = r.next();
      if (p.t !== 'ident' && p.t !== 'kw') r.fail(`expected field name after '.', got '${p.v}'`, p);
      path.push(p.v);
    }
    lhs = { k: 'ref', path };
  } else r.fail(`unexpected token '${t.v}'`, t);

  for (;;) {
    const p = r.peek();
    const op = (p.t === 'sym' || p.t === 'kw') ? p.v : undefined;
    const bp = BIN_BP[op];
    if (bp === undefined || bp < minBp) return lhs;
    r.next();
    const rhs = parseExpr(r, bp + 1);
    lhs = { k: 'bin', op: normOp(op), l: lhs, r: rhs };
  }
}

export function parseExpression(src) {
  const r = new Reader(lex(src));
  const e = parseExpr(r, 0);
  if (r.peek().t !== 'eof') r.fail(`unexpected trailing token '${r.peek().v}'`);
  return e;
}

function parseAccount(r) {
  r.expectKw('account');
  const name = r.expectIdent();
  r.expectSym('{');
  const acct = { name, capacityExpr: null, strategies: [], invariants: [] };
  for (;;) {
    const t = r.peek();
    if (t.t === 'sym' && t.v === '}') break;
    if (t.t === 'kw' && t.v === 'capacity') {
      r.next();
      if (acct.capacityExpr) r.fail(`duplicate capacity in account '${name}'`);
      acct.capacityExpr = parseExpr(r, 0);
      r.expectSym(';');
    } else if (t.t === 'kw' && t.v === 'strategy') {
      r.next();
      const sname = r.expectIdent();
      r.expectSym('{');
      r.expectKw('limit');
      const limitExpr = parseExpr(r, 0);
      r.expectSym(';');
      r.expectSym('}');
      acct.strategies.push({ name: sname, limitExpr });
    } else if (t.t === 'kw' && t.v === 'invariant') {
      r.next();
      acct.invariants.push(parseExpr(r, 0));
      r.expectSym(';');
    } else r.fail(`unexpected token '${t.v}' in account body`, t);
  }
  r.expectSym('}');
  return acct;
}

function parseOrder(r) {
  r.expectKw('order');
  const name = r.expectIdent();
  r.expectSym('{');
  const order = { name, accountName: null, strategyName: null, amountExpr: null };
  for (;;) {
    const t = r.peek();
    if (t.t === 'sym' && t.v === '}') break;
    if (t.t === 'kw' && t.v === 'account') {
      r.next();
      if (order.accountName) r.fail(`duplicate account in order '${name}'`);
      order.accountName = r.expectIdent();
      r.expectSym(';');
    } else if (t.t === 'kw' && t.v === 'strategy') {
      r.next();
      if (order.strategyName) r.fail(`duplicate strategy in order '${name}'`);
      order.strategyName = r.expectIdent();
      r.expectSym(';');
    } else if (t.t === 'kw' && t.v === 'amount') {
      r.next();
      if (order.amountExpr) r.fail(`duplicate amount in order '${name}'`);
      order.amountExpr = parseExpr(r, 0);
      r.expectSym(';');
    } else r.fail(`unexpected token '${t.v}' in order body`, t);
  }
  r.expectSym('}');
  return order;
}

function parseHistory(r) {
  r.expectKw('history');
  r.expectSym('{');
  const ops = [];
  for (;;) {
    const t = r.peek();
    if (t.t === 'sym' && t.v === '}') break;
    r.expectKw('op');
    const id = r.expectIdent();
    r.expectSym('=');
    const kt = r.next();
    if (kt.t !== 'kw' || !['reserve', 'confirm', 'release'].includes(kt.v)) {
      r.fail(`expected reserve|confirm|release, got '${kt.v}'`, kt);
    }
    const order = r.expectIdent();
    r.expectKw('invoke');
    const invoke = r.expectNum();
    let response = null;
    let result = null;
    if (r.peek().t === 'kw' && r.peek().v === 'response') {
      r.next();
      response = r.expectNum();
      const rt = r.next();
      if (rt.t !== 'kw' || (rt.v !== 'ok' && rt.v !== 'fail')) {
        r.fail(`expected ok|fail after response, got '${rt.v}'`, rt);
      }
      result = rt.v;
    } else {
      r.expectKw('pending');
    }
    r.expectSym(';');
    ops.push({ id, kind: kt.v, order, invoke, response, result });
  }
  r.expectSym('}');
  return ops;
}

export function parseSpec(src) {
  const r = new Reader(lex(src));
  const spec = { accounts: [], orders: [], history: [] };
  while (r.peek().t !== 'eof') {
    const t = r.peek();
    if (t.t === 'kw' && t.v === 'account') spec.accounts.push(parseAccount(r));
    else if (t.t === 'kw' && t.v === 'order') spec.orders.push(parseOrder(r));
    else if (t.t === 'kw' && t.v === 'history') spec.history.push(...parseHistory(r));
    else r.fail(`unexpected token '${t.v}' at top level`, t);
  }
  return spec;
}
