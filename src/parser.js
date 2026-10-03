import { err } from './errors.js';

const TYPE_NAMES = new Set(['money', 'bps', 'units']);
const ROUND_MODES = new Set(['HALF_UP', 'HALF_EVEN', 'DOWN']);
const INFIX_BP = new Map([
  ['or', 5], ['and', 8],
  ['==', 10], ['!=', 10], ['<', 10], ['<=', 10], ['>', 10], ['>=', 10],
  ['+', 20], ['-', 20], ['*', 30],
]);

export function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const atPunct = (v) => peek().t === 'PUNCT' && peek().value === v;
  const atKw = (v) => peek().t === 'KW' && peek().value === v;
  const here = () => `${peek().pos.line}:${peek().pos.col}`;
  const fail = (msg) => { throw err('E_PARSE', `${msg} at ${here()}`); };
  const expectPunct = (v) => { if (!atPunct(v)) fail(`expected '${v}', found '${peek().value ?? peek().t}'`); return tokens[p++]; };
  const expectKw = (v) => { if (!atKw(v)) fail(`expected keyword '${v}'`); return tokens[p++]; };
  const expectIdent = () => { if (peek().t !== 'IDENT') fail(`expected identifier, found '${peek().value ?? peek().t}'`); return tokens[p++].value; };

  function parseLiteral() {
    const tok = peek();
    if (tok.t === 'MONEY') { p += 1; return { kind: 'lit', vtype: 'money', value: tok.value, raw: tok.raw }; }
    if (tok.t === 'UNITS') { p += 1; return { kind: 'lit', vtype: 'units', value: tok.value, raw: tok.raw }; }
    if (tok.t === 'BPS') { p += 1; return { kind: 'lit', vtype: 'bps', value: tok.value, raw: tok.raw }; }
    if (tok.t === 'KW' && (tok.value === 'true' || tok.value === 'false')) {
      p += 1;
      return { kind: 'lit', vtype: 'bool', value: tok.value === 'true' };
    }
    return null;
  }

  function parsePrefix() {
    const tok = peek();
    if (tok.t === 'PUNCT' && tok.value === '-') { p += 1; return { kind: 'neg', expr: parseExpr(40) }; }
    if (tok.t === 'KW' && tok.value === 'not') { p += 1; return { kind: 'not', expr: parseExpr(40) }; }
    if (tok.t === 'PUNCT' && tok.value === '(') {
      p += 1;
      const e = parseExpr(0);
      expectPunct(')');
      return e;
    }
    if (tok.t === 'KW' && tok.value === 'tier') return parseTier();
    if (tok.t === 'KW' && tok.value === 'it') { p += 1; return { kind: 'ident', name: 'it' }; }
    if (tok.t === 'IDENT') {
      p += 1;
      const name = tok.value;
      if (atPunct('(')) {
        p += 1;
        const args = [];
        if (!atPunct(')')) {
          for (;;) {
            args.push(parseExpr(0));
            if (atPunct(',')) { p += 1; continue; }
            break;
          }
        }
        expectPunct(')');
        return { kind: 'call', name, args };
      }
      return { kind: 'ident', name };
    }
    const lit = parseLiteral();
    if (lit) return lit;
    fail(`unexpected token '${tok.value ?? tok.t}'`);
    return null;
  }

  function parseExpr(minBp) {
    let left = parsePrefix();
    for (;;) {
      const tok = peek();
      let op = null;
      if (tok.t === 'PUNCT' && INFIX_BP.has(tok.value)) op = tok.value;
      else if (tok.t === 'KW' && INFIX_BP.has(tok.value)) op = tok.value;
      if (op === null || INFIX_BP.get(op) < minBp) break;
      p += 1;
      const right = parseExpr(INFIX_BP.get(op) + 1);
      left = { kind: 'bin', op, l: left, r: right };
    }
    return left;
  }

  function parseTier() {
    expectKw('tier');
    expectKw('on');
    const on = parseExpr(0);
    expectPunct('{');
    const arms = [];
    for (;;) {
      if (atKw('else')) {
        p += 1;
        expectPunct('->');
        arms.push({ cond: null, value: parseExpr(0) });
        if (atPunct(',')) p += 1;
        break;
      }
      const cond = parseExpr(0);
      expectPunct('->');
      const value = parseExpr(0);
      arms.push({ cond, value });
      if (atPunct(',')) { p += 1; continue; }
      break;
    }
    expectPunct('}');
    if (arms.length === 0) fail('tier block must have at least one arm');
    return { kind: 'tier', on, arms };
  }

  function parseTypeName() {
    const tok = peek();
    if (tok.t === 'KW' && TYPE_NAMES.has(tok.value)) { p += 1; return tok.value; }
    fail(`expected type (money|bps|units), found '${tok.value ?? tok.t}'`);
    return null;
  }

  function parseStmt() {
    if (atKw('let')) {
      p += 1;
      const name = expectIdent();
      expectPunct('=');
      const expr = parseExpr(0);
      expectPunct(';');
      return { kind: 'let', name, expr };
    }
    if (atKw('return')) {
      p += 1;
      const expr = parseExpr(0);
      expectPunct(';');
      return { kind: 'return', expr };
    }
    if (atKw('conserve')) {
      p += 1;
      const e = parseExpr(0);
      expectPunct(';');
      if (e.kind !== 'bin' || e.op !== '==') fail('conserve expects the form: conserve <total> == <part> + ... ;');
      return { kind: 'conserve', left: e.l, right: e.r };
    }
    if (atKw('allocate')) {
      p += 1;
      const total = parseExpr(0);
      expectPunct('{');
      const shares = [];
      let residual = null;
      while (!atPunct('}')) {
        if (atKw('residual')) {
          p += 1;
          expectPunct('->');
          const acc = tokens[p++];
          if (acc.t !== 'STRING') fail('residual target must be a string account name');
          if (residual !== null) fail('duplicate residual account');
          residual = acc.value;
          expectPunct(';');
        } else {
          const account = expectIdent();
          expectPunct(':');
          const expr = parseExpr(0);
          expectPunct(';');
          shares.push({ account, expr });
        }
      }
      expectPunct('}');
      if (shares.length === 0) fail('allocate requires at least one share');
      if (residual === null) fail('allocate requires a residual account');
      return { kind: 'allocate', total, shares, residual };
    }
    fail(`expected statement (let|return|conserve|allocate), found '${peek().value ?? peek().t}'`);
    return null;
  }

  function parseFeeFn() {
    expectKw('fee');
    const name = expectIdent();
    expectPunct('(');
    const params = [];
    if (!atPunct(')')) {
      for (;;) {
        const pname = expectIdent();
        expectPunct(':');
        const ptype = parseTypeName();
        params.push({ name: pname, type: ptype });
        if (atPunct(',')) { p += 1; continue; }
        break;
      }
    }
    expectPunct(')');
    let retType = 'money';
    if (atPunct('->')) { p += 1; retType = parseTypeName(); }
    expectPunct('{');
    const body = [];
    while (!atPunct('}')) body.push(parseStmt());
    expectPunct('}');
    return { kind: 'feeFn', name, params, retType, body };
  }

  function parseParamDecl() {
    expectKw('param');
    const name = expectIdent();
    expectPunct('=');
    const lit = parseLiteral();
    if (!lit || lit.vtype === 'bool') fail('param value must be a money/bps/units literal');
    expectPunct(';');
    return { kind: 'param', name, lit };
  }

  const body = [];
  while (peek().t !== 'EOF') {
    if (atKw('currency')) {
      p += 1;
      const name = expectIdent();
      expectPunct(';');
      body.push({ kind: 'currency', name });
    } else if (atKw('rounding')) {
      p += 1;
      const tok = tokens[p++];
      if (tok.t !== 'KW' || !ROUND_MODES.has(tok.value)) {
        fail(`expected rounding mode (HALF_UP|HALF_EVEN|DOWN), found '${tok.value ?? tok.t}'`);
      }
      expectPunct(';');
      body.push({ kind: 'rounding', mode: tok.value });
    } else if (atKw('param')) {
      body.push(parseParamDecl());
    } else if (atKw('class')) {
      p += 1;
      const name = expectIdent();
      expectPunct('{');
      const members = [];
      while (!atPunct('}')) {
        if (atKw('param')) members.push(parseParamDecl());
        else if (atKw('fee')) members.push(parseFeeFn());
        else fail(`expected 'param' or 'fee' in class body, found '${peek().value ?? peek().t}'`);
      }
      expectPunct('}');
      body.push({ kind: 'class', name, members });
    } else {
      fail(`unexpected top-level token '${peek().value ?? peek().t}'`);
    }
  }
  return { kind: 'program', body };
}
