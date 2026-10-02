import { E } from './errors.js';

// Static checker.
//  - Types: template parameters are inferred as 'account' (used in account
//    position) or 'value' (used as $param in amount expressions). Mixing is
//    a type error. Lexical scoping: a template may only reference its own
//    parameters; nothing leaks in or out across templates.
//  - Balance: amount expressions are normalized to polynomials over value
//    parameters; every template must satisfy its `balance` condition (or the
//    default debit == credit) for ALL parameter values, else E_BALANCE.
//  - Periods: batches may only bind declared periods, else E_PERIOD.

const EPS = 1e-9;

function polyConst(c) { return new Map([['', c]]); }
function polyVar(name) { return new Map([[name, 1]]); }

function polyAdd(a, b) {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, (out.get(k) || 0) + v);
  return polyPrune(out);
}
function polyScale(a, s) {
  const out = new Map();
  for (const [k, v] of a) out.set(k, v * s);
  return polyPrune(out);
}
function polyMul(a, b) {
  const out = new Map();
  for (const [ka, va] of a) {
    for (const [kb, vb] of b) {
      const key = [ka, kb].filter(Boolean).sort().join('*');
      out.set(key, (out.get(key) || 0) + va * vb);
    }
  }
  return polyPrune(out);
}
function polyPrune(p) {
  for (const [k, v] of p) if (Math.abs(v) < EPS) p.delete(k);
  return p;
}
function polyIsZero(p) { return p.size === 0; }
function polyToString(p) {
  if (p.size === 0) return '0';
  return [...p.entries()].map(([k, v]) => (k === '' ? `${v}` : `${v}*${k}`)).join(' + ');
}

export function check(program) {
  const declaredPeriods = new Set(program.periods.map((p) => p.name));
  const templateNames = new Set();
  const checkedTemplates = new Map();

  for (const t of program.templates) {
    if (templateNames.has(t.name)) throw E.compile(`duplicate template '${t.name}'`);
    templateNames.add(t.name);
    checkedTemplates.set(t.name, checkTemplate(t));
  }

  const batches = new Map();
  for (const b of program.batches) {
    if (batches.has(b.name)) throw E.compile(`duplicate batch '${b.name}'`);
    if (!declaredPeriods.has(b.period)) {
      throw E.period(`batch '${b.name}' binds undeclared period '${b.period}'`);
    }
    for (const tpl of b.allow) {
      if (!templateNames.has(tpl)) throw E.compile(`batch '${b.name}' allows unknown template '${tpl}'`);
    }
    batches.set(b.name, { name: b.name, period: b.period, allow: b.allow });
  }

  return { periods: [...declaredPeriods], templates: checkedTemplates, batches };
}

function checkTemplate(t) {
  const paramSet = new Set(t.params);
  if (paramSet.size !== t.params.length) throw E.scope(`template '${t.name}' has duplicate parameters`);
  const kinds = new Map(); // param -> 'account' | 'value'

  const markKind = (name, kind, line) => {
    if (!paramSet.has(name)) {
      throw E.scope(`template '${t.name}' references '${name}' which is not its parameter (line ${line}); template scopes are closed`);
    }
    const prev = kinds.get(name);
    if (prev && prev !== kind) {
      throw E.type(`parameter '${name}' of template '${t.name}' used as both ${prev} and ${kind}`);
    }
    kinds.set(name, kind);
  };

  const debitExprs = [];
  const creditExprs = [];
  let balanceExpr = null;

  for (const stmt of t.body) {
    if (stmt.type === 'debit' || stmt.type === 'credit') {
      if (paramSet.has(stmt.account)) markKind(stmt.account, 'account', stmt.line);
      for (const name of collectParams(stmt.expr)) markKind(name, 'value', stmt.line);
      (stmt.type === 'debit' ? debitExprs : creditExprs).push(stmt.expr);
    } else if (stmt.type === 'balance') {
      if (balanceExpr) throw E.parse(`template '${t.name}' has more than one balance condition`);
      if (stmt.expr.kind !== 'bin' || stmt.expr.op !== '==') {
        throw E.parse(`balance condition in template '${t.name}' must be an equality (line ${stmt.line})`);
      }
      for (const name of collectParams(stmt.expr)) markKind(name, 'value', stmt.line);
      balanceExpr = stmt.expr;
    }
  }

  const toPoly = (expr) => exprToPoly(expr, t.name);
  const debitSum = debitExprs.map(toPoly).reduce(polyAdd, polyConst(0));
  const creditSum = creditExprs.map(toPoly).reduce(polyAdd, polyConst(0));

  const residual = balanceExpr
    ? balanceToPoly(balanceExpr, debitSum, creditSum, t.name)
    : polyAdd(debitSum, polyScale(creditSum, -1));

  if (!polyIsZero(residual)) {
    throw E.balance(`template '${t.name}' is not provably balanced; residual = ${polyToString(residual)}`);
  }

  return {
    name: t.name,
    params: t.params,
    kinds,
    body: t.body,
    accountParams: t.params.filter((p) => kinds.get(p) === 'account'),
    hasExplicitBalance: Boolean(balanceExpr)
  };
}

function collectParams(expr, out = []) {
  if (expr.kind === 'param') out.push(expr.name);
  else if (expr.kind === 'bin') { collectParams(expr.left, out); collectParams(expr.right, out); }
  return out;
}

function exprToPoly(expr, tplName) {
  switch (expr.kind) {
    case 'num': return polyConst(expr.value);
    case 'param': return polyVar(expr.name);
    case 'total': throw E.parse(`'${expr.side}' total is only allowed directly in a balance condition (template '${tplName}')`);
    case 'bin': {
      const l = exprToPoly(expr.left, tplName);
      const r = exprToPoly(expr.right, tplName);
      if (expr.op === '+') return polyAdd(l, r);
      if (expr.op === '-') return polyAdd(l, polyScale(r, -1));
      if (expr.op === '*') return polyMul(l, r);
      if (expr.op === '/') {
        if (!(r.size === 1 && r.has(''))) {
          throw E.compile(`template '${tplName}': divisor must be a constant (line ${expr.line})`);
        }
        const d = r.get('');
        if (Math.abs(d) < EPS) throw E.compile(`template '${tplName}': division by zero (line ${expr.line})`);
        return polyScale(l, 1 / d);
      }
      throw E.parse(`operator '==' is only allowed at the top of a balance condition (template '${tplName}')`);
    }
    default: throw E.compile(`unknown expression kind '${expr.kind}'`);
  }
}

function balanceToPoly(expr, debitSum, creditSum, tplName) {
  // expr is guaranteed to be `lhs == rhs`; result must be the zero polynomial.
  const evalSide = (e) => {
    if (e.kind === 'total') return e.side === 'debit' ? debitSum : creditSum;
    if (e.kind === 'bin') {
      const l = evalSide(e.left);
      const r = evalSide(e.right);
      if (e.op === '+') return polyAdd(l, r);
      if (e.op === '-') return polyAdd(l, polyScale(r, -1));
      if (e.op === '*') return polyMul(l, r);
      if (e.op === '/') {
        if (!(r.size === 1 && r.has(''))) throw E.compile(`template '${tplName}': divisor must be a constant`);
        return polyScale(l, 1 / r.get(''));
      }
      throw E.parse(`nested '==' in balance condition of template '${tplName}'`);
    }
    return exprToPoly(e, tplName);
  };
  return polyAdd(evalSide(expr.left), polyScale(evalSide(expr.right), -1));
}
