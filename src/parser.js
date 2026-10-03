import { QuotaError } from './errors.js';

// Pratt 绑定力: or < and < ==/!= < 比较/matches < +/- < */ 
const BINOPS = new Map([
  ['or', 1],
  ['and', 2],
  ['==', 3],
  ['!=', 3],
  ['<', 4],
  ['<=', 4],
  ['>', 4],
  ['>=', 4],
  ['matches', 4],
  ['+', 5],
  ['-', 5],
  ['*', 6],
  ['/', 6],
]);

const GUARD_TARGETS = new Set(['freeze', 'unfreeze', 'debit', 'draw']);

export function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const fail = (msg, tok = peek()) => {
    throw new QuotaError('E_PARSE', `${msg} (line ${tok.line}, col ${tok.col})`);
  };
  const isKw = (v) => peek().t === 'kw' && peek().v === v;
  const isOp = (v) => peek().t === 'op' && peek().v === v;
  const isPunct = (v) => peek().t === 'punct' && peek().v === v;
  const expectPunct = (v) => {
    if (!isPunct(v)) fail(`expected '${v}'`);
    next();
  };
  const expectKw = (v) => {
    if (!isKw(v)) fail(`expected keyword '${v}'`);
    next();
  };

  function parseExpr(minBp = 0) {
    let left = parsePrefix();
    for (;;) {
      const t = peek();
      const opText = t.t === 'op' || t.t === 'kw' ? t.v : null;
      const bp = opText ? BINOPS.get(opText) : undefined;
      if (!bp || bp < minBp) return left;
      next();
      const right = parseExpr(bp + 1);
      left = { k: 'bin', op: opText, l: left, r: right, line: t.line, col: t.col };
    }
  }

  function parsePrefix() {
    const t = next();
    switch (t.t) {
      case 'num':
        return { k: 'num', v: t.v, line: t.line, col: t.col };
      case 'str':
        return { k: 'str', v: t.v, line: t.line, col: t.col };
      case 'date':
        return { k: 'date', v: t.v, line: t.line, col: t.col };
      case 'regex':
        return { k: 'regex', source: t.v.source, flags: t.v.flags, line: t.line, col: t.col };
      case 'punct':
        if (t.v === '(') {
          const e = parseExpr();
          expectPunct(')');
          return e;
        }
        fail(`unexpected '${t.v}'`);
        break;
      case 'op':
        if (t.v === '-') return { k: 'un', op: '-', e: parseExpr(7), line: t.line, col: t.col };
        fail(`unexpected operator '${t.v}'`);
        break;
      case 'kw': {
        if (t.v === 'limit' && isPunct('(')) {
          next();
          const arg = next();
          if (arg.t !== 'str') fail('builtin expects a bucket name string, e.g. limit("loan")');
          expectPunct(')');
          return { k: 'builtin', fn: 'limit', bucket: arg.v, line: t.line, col: t.col };
        }
        if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true', line: t.line, col: t.col };
        if (t.v === 'amount') return { k: 'amount', line: t.line, col: t.col };
        if (t.v === 'note') return { k: 'note', line: t.line, col: t.col };
        if (t.v === 'not') return { k: 'un', op: 'not', e: parseExpr(3), line: t.line, col: t.col };
        fail(`unexpected keyword '${t.v}'`, t);
        break;
      }
      case 'ident': {
        if (isPunct('(')) {
          next();
          if (!['limit', 'frozen', 'available'].includes(t.v)) {
            fail(`unknown builtin '${t.v}' (expected limit/frozen/available)`, t);
          }
          const arg = next();
          if (arg.t !== 'str') fail('builtin expects a bucket name string, e.g. available("loan")');
          expectPunct(')');
          return { k: 'builtin', fn: t.v, bucket: arg.v, line: t.line, col: t.col };
        }
        return { k: 'var', name: t.v, line: t.line, col: t.col };
      }
      default:
        fail(`unexpected token '${t.v ?? t.t}'`, t);
    }
  }

  function parseStatement() {
    const t = peek();
    if (t.t !== 'kw') fail('expected a statement', t);
    switch (t.v) {
      case 'customer': {
        next();
        const id = next();
        if (id.t !== 'cid') fail('expected a customer number like C1001');
        expectPunct(';');
        return { k: 'customer', id: id.v, line: t.line };
      }
      case 'note_whitelist': {
        next();
        const r = next();
        if (r.t !== 'regex') fail('expected a regex literal, e.g. note_whitelist /^REQ-[0-9]+$/;');
        expectPunct(';');
        return { k: 'note_whitelist', source: r.v.source, flags: r.v.flags, line: t.line };
      }
      case 'bucket': {
        next();
        const name = next();
        if (name.t !== 'ident') fail('expected a bucket name');
        expectKw('limit');
        const limit = parseExpr();
        expectPunct(';');
        return { k: 'bucket', name: name.v, limit, line: t.line };
      }
      case 'validity': {
        next();
        const from = next();
        if (from.t !== 'date') fail('expected a date like 2026-01-01');
        expectKw('to');
        const to = next();
        if (to.t !== 'date') fail('expected a date like 2026-12-31');
        expectPunct(';');
        return { k: 'validity', from: from.v, to: to.v, line: t.line };
      }
      case 'scope': {
        next();
        const name = next();
        if (name.t !== 'ident') fail('expected a scope name');
        expectPunct('{');
        const body = [];
        while (!isPunct('}')) {
          if (peek().t === 'eof') fail('unterminated scope block');
          body.push(parseStatement());
        }
        next();
        return { k: 'scope', name: name.v, body, line: t.line };
      }
      case 'cap': {
        next();
        const b = next();
        if (b.t !== 'ident') fail('expected a bucket name');
        const value = parseExpr();
        expectPunct(';');
        return { k: 'cap', bucket: b.v, value, line: t.line };
      }
      case 'let':
      case 'var': {
        next();
        const name = next();
        if (name.t !== 'ident') fail('expected a variable name');
        if (!isOp('=')) fail("expected '='");
        next();
        const expr = parseExpr();
        expectPunct(';');
        return { k: 'decl', mutable: t.v === 'var', name: name.v, expr, line: t.line };
      }
      case 'set': {
        next();
        const name = next();
        if (name.t !== 'ident') fail('expected a variable name');
        if (!isOp('=')) fail("expected '='");
        next();
        const expr = parseExpr();
        expectPunct(';');
        return { k: 'set', name: name.v, expr, line: t.line };
      }
      case 'guard': {
        next();
        const tgt = next();
        if (tgt.t !== 'kw' || !GUARD_TARGETS.has(tgt.v)) {
          fail('expected one of freeze/unfreeze/debit/draw after guard');
        }
        const clauses = [];
        for (;;) {
          if (isKw('when')) {
            next();
            clauses.push({ mode: 'when', expr: parseExpr() });
            continue;
          }
          if (isKw('unless')) {
            next();
            clauses.push({ mode: 'unless', expr: parseExpr() });
            continue;
          }
          break;
        }
        if (!clauses.length) fail('guard needs at least one when/unless clause');
        expectPunct(';');
        return { k: 'guard', target: tgt.v, clauses, line: t.line };
      }
      default:
        fail(`unexpected keyword '${t.v}'`, t);
    }
  }

  const body = [];
  while (peek().t !== 'eof') body.push(parseStatement());
  return { k: 'program', body };
}
