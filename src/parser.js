import { tokenize } from './lexer.js';
import { LimError } from './errors.js';

// Infix binding powers for the Pratt parser. Comparisons are non-associative.
const BIN_PREC = {
  '==': 10, '!=': 10, '<=': 10, '<': 10, '>=': 10, '>': 10,
  '+': 20, '-': 20,
  '*': 30,
};
const COMPARISONS = new Set(['==', '!=', '<=', '<', '>=', '>']);
const UNARY_PREC = 40;

export function parseSpec(src) {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const fail = (msg) => {
    const t = peek();
    throw new LimError('E_TYPE', `${msg} at line ${t.line}:${t.col}, got '${t.value ?? 'EOF'}'`);
  };
  const expect = (type, value) => {
    const t = next();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new LimError('E_TYPE', `expected '${value ?? type}' at line ${t.line}:${t.col}, got '${t.value ?? t.type}'`);
    }
    return t;
  };
  const expectKw = (kw) => expect('kw', kw);

  function parseExpr(minPrec = 0) {
    let left = parsePrefix();
    for (;;) {
      const t = peek();
      if (t.type !== 'op') break;
      const prec = BIN_PREC[t.value];
      if (prec === undefined || prec < minPrec) break;
      if (COMPARISONS.has(t.value) && left.type === 'bin' && COMPARISONS.has(left.op)) {
        throw new LimError('E_TYPE',
          `comparison '${t.value}' is non-associative at line ${t.line}:${t.col}; use parentheses`);
      }
      next();
      // Non-associative comparisons: right side binds tighter, so `a < b < c` is rejected.
      const right = parseExpr(prec + 1);
      left = { type: 'bin', op: t.value, left, right };
    }
    return left;
  }

  function parsePrefix() {
    const t = next();
    if (t.type === 'num') return { type: 'num', value: t.value };
    if (t.type === 'op' && t.value === '-') {
      return { type: 'neg', expr: parseExpr(UNARY_PREC) };
    }
    if (t.type === 'punct' && t.value === '(') {
      const e = parseExpr(0);
      expect('punct', ')');
      return e;
    }
    if (t.type === 'kw' && (t.value === 'used' || t.value === 'quota')) {
      const kind = t.value;
      expect('punct', '(');
      const name = expect('ident').value;
      expect('punct', ')');
      return { type: kind, strategy: name };
    }
    if (t.type === 'kw' && t.value === 'capacity') return { type: 'capacity' };
    if (t.type === 'ident') return { type: 'var', name: t.value };
    fail(`unexpected token '${t.value ?? t.type}'`);
    return null;
  }

  function parsePositiveInt(what) {
    const t = next();
    if (t.type !== 'num' || !Number.isInteger(t.value) || t.value <= 0) {
      throw new LimError('E_TYPE', `${what} must be a positive integer at line ${t.line}:${t.col}`);
    }
    return t.value;
  }

  function parseOrder() {
    const name = expect('ident').value;
    expect('punct', '{');
    const order = { name, strategy: null, amount: null, clock: null };
    for (;;) {
      const t = peek();
      if (t.type === 'punct' && t.value === '}') { next(); break; }
      const kw = expect('kw').value;
      if (kw === 'strategy') order.strategy = expect('ident').value;
      else if (kw === 'amount') order.amount = parsePositiveInt('order amount');
      else if (kw === 'clock') {
        const c = next();
        if (c.type !== 'num' || !Number.isInteger(c.value) || c.value < 0) {
          throw new LimError('E_TYPE', `clock must be a non-negative integer at line ${c.line}:${c.col}`);
        }
        order.clock = c.value;
      } else {
        throw new LimError('E_TYPE', `unexpected order attribute '${kw}' at line ${t.line}:${t.col}`);
      }
    }
    return order;
  }

  function parseAccount() {
    expectKw('account');
    const name = expect('ident').value;
    expect('punct', '{');
    const account = { name, capacity: null, strategies: [], constraints: [], orders: [], clock: null };
    for (;;) {
      const t = peek();
      if (t.type === 'punct' && t.value === '}') { next(); break; }
      if (t.type !== 'kw') fail(`expected keyword, got '${t.value ?? t.type}'`);
      const kw = next().value;
      if (kw === 'capacity') {
        if (account.capacity !== null) throw new LimError('E_TYPE', `duplicate capacity in account '${name}'`);
        account.capacity = parsePositiveInt('capacity');
      } else if (kw === 'strategy') {
        const sname = expect('ident').value;
        expect('punct', '{');
        expectKw('quota');
        const quota = parsePositiveInt('quota');
        expect('punct', '}');
        account.strategies.push({ name: sname, quota });
      } else if (kw === 'constraint') {
        account.constraints.push(parseExpr(0));
      } else if (kw === 'order') {
        account.orders.push(parseOrder());
      } else if (kw === 'clock') {
        if (account.clock !== null) throw new LimError('E_TYPE', `duplicate clock in account '${name}'`);
        const c = next();
        if (c.type !== 'num' || !Number.isInteger(c.value) || c.value < 0) {
          throw new LimError('E_TYPE', `clock must be a non-negative integer at line ${c.line}:${c.col}`);
        }
        account.clock = c.value;
      } else {
        throw new LimError('E_TYPE', `unexpected keyword '${kw}' in account '${name}'`);
      }
    }
    return account;
  }

  const accounts = [];
  for (;;) {
    const t = peek();
    if (t.type === 'eof') break;
    if (t.type === 'kw' && t.value === 'account') accounts.push(parseAccount());
    else fail(`expected 'account', got '${t.value ?? t.type}'`);
  }
  if (accounts.length === 0) throw new LimError('E_TYPE', 'spec must contain at least one account');
  return { accounts };
}
