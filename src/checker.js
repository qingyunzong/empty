import { err } from './errors.js';

const NUMERIC = new Set(['money', 'bps', 'units']);

function checkExpr(e, env) {
  switch (e.kind) {
    case 'lit':
      e.t = e.vtype;
      return e.t;
    case 'ident': {
      const t = env.get(e.name);
      if (t === undefined) throw err('E_NAME', `unknown identifier '${e.name}'`);
      e.t = t;
      return t;
    }
    case 'neg': {
      const t = checkExpr(e.expr, env);
      if (!NUMERIC.has(t)) throw err('E_TYPE', `unary '-' requires a numeric operand, got ${t}`);
      e.t = t;
      return t;
    }
    case 'not': {
      const t = checkExpr(e.expr, env);
      if (t !== 'bool') throw err('E_TYPE', `'not' requires a bool operand, got ${t}`);
      e.t = 'bool';
      return e.t;
    }
    case 'bin': {
      const lt = checkExpr(e.l, env);
      const rt = checkExpr(e.r, env);
      if (e.op === 'and' || e.op === 'or') {
        if (lt !== 'bool' || rt !== 'bool') throw err('E_TYPE', `'${e.op}' requires bool operands, got ${lt} and ${rt}`);
        e.t = 'bool';
        return e.t;
      }
      if (e.op === '+' || e.op === '-') {
        if (!NUMERIC.has(lt) || lt !== rt) {
          throw err('E_TYPE', `cannot ${e.op === '+' ? 'add' : 'subtract'} ${lt} and ${rt} (bps and money must not be mixed)`);
        }
        e.t = lt;
        return e.t;
      }
      if (e.op === '*') {
        const pair = `${lt}*${rt}`;
        if (pair === 'money*bps' || pair === 'bps*money' || pair === 'units*money' || pair === 'money*units') {
          e.t = 'money';
          return e.t;
        }
        throw err('E_TYPE', `invalid multiplication ${lt} * ${rt}`);
      }
      // comparisons
      if (lt !== rt) throw err('E_TYPE', `cannot compare ${lt} with ${rt}`);
      if (!NUMERIC.has(lt) && lt !== 'bool') throw err('E_TYPE', `cannot compare values of type ${lt}`);
      e.t = 'bool';
      return e.t;
    }
    case 'call': {
      if (e.name !== 'min' && e.name !== 'max' && e.name !== 'clamp') {
        throw err('E_TYPE', `unknown function '${e.name}'`);
      }
      const need = e.name === 'clamp' ? 3 : 2;
      if (e.args.length < need) throw err('E_TYPE', `${e.name} expects at least ${need} arguments`);
      const ts = e.args.map((a) => checkExpr(a, env));
      for (const t of ts) {
        if (!NUMERIC.has(t)) throw err('E_TYPE', `${e.name} arguments must be numeric, got ${t}`);
        if (t !== ts[0]) throw err('E_TYPE', `${e.name} arguments must share one type, got ${ts[0]} and ${t}`);
      }
      e.t = ts[0];
      return e.t;
    }
    case 'tier': {
      const onT = checkExpr(e.on, env);
      if (!NUMERIC.has(onT)) throw err('E_TYPE', `tier 'on' expression must be numeric, got ${onT}`);
      const inner = new Map(env);
      inner.set('it', onT);
      let armT = null;
      for (const arm of e.arms) {
        if (arm.cond) {
          const ct = checkExpr(arm.cond, inner);
          if (ct !== 'bool') throw err('E_TYPE', `tier arm condition must be bool, got ${ct}`);
        }
        const vt = checkExpr(arm.value, inner);
        if (armT === null) armT = vt;
        else if (vt !== armT) throw err('E_TYPE', `tier arms must share one type, got ${armT} and ${vt}`);
      }
      e.t = armT;
      return e.t;
    }
    default:
      throw err('E_TYPE', `cannot type-check node kind '${e.kind}'`);
  }
}

export function check(program) {
  const contract = {
    currency: null,
    rounding: 'HALF_EVEN',
    params: new Map(),
    classes: new Map(),
  };

  for (const stmt of program.body) {
    if (stmt.kind === 'currency') {
      if (contract.currency !== null) throw err('E_PARSE', 'duplicate currency declaration');
      contract.currency = stmt.name;
    } else if (stmt.kind === 'rounding') {
      contract.rounding = stmt.mode;
    } else if (stmt.kind === 'param') {
      if (contract.params.has(stmt.name)) throw err('E_PARSE', `duplicate param '${stmt.name}'`);
      contract.params.set(stmt.name, { t: stmt.lit.vtype, v: stmt.lit.value });
    } else if (stmt.kind === 'class') {
      if (contract.classes.has(stmt.name)) throw err('E_PARSE', `duplicate class '${stmt.name}'`);
      const cls = { name: stmt.name, params: new Map(), fns: new Map() };
      for (const m of stmt.members) {
        if (m.kind === 'param') {
          if (cls.params.has(m.name)) throw err('E_PARSE', `duplicate param '${m.name}' in class '${stmt.name}'`);
          cls.params.set(m.name, { t: m.lit.vtype, v: m.lit.value });
        } else {
          if (cls.fns.has(m.name)) throw err('E_PARSE', `duplicate fee fn '${m.name}' in class '${stmt.name}'`);
          cls.fns.set(m.name, m);
        }
      }
      contract.classes.set(stmt.name, cls);
    }
  }
  if (contract.classes.size === 0) throw err('E_PARSE', 'contract must declare at least one class');

  for (const cls of contract.classes.values()) {
    for (const fn of cls.fns.values()) {
      const env = new Map();
      for (const prm of fn.params) env.set(prm.name, prm.type);
      for (const [name, p] of contract.params) if (!env.has(name)) env.set(name, p.t);
      for (const [name, p] of cls.params) env.set(name, p.t);

      const locals = new Map(env);
      for (const stmt of fn.body) {
        if (stmt.kind === 'let') {
          const t = checkExpr(stmt.expr, locals);
          locals.set(stmt.name, t);
        } else if (stmt.kind === 'return') {
          const t = checkExpr(stmt.expr, locals);
          if (t !== fn.retType) {
            throw err('E_TYPE', `fee '${fn.name}' must return ${fn.retType}, got ${t}`);
          }
        } else if (stmt.kind === 'conserve') {
          const lt = checkExpr(stmt.left, locals);
          const rt = checkExpr(stmt.right, locals);
          if (lt !== 'money' || rt !== 'money') {
            throw err('E_TYPE', `conserve compares money totals, got ${lt} and ${rt}`);
          }
        } else if (stmt.kind === 'allocate') {
          const tt = checkExpr(stmt.total, locals);
          if (tt !== 'money') throw err('E_TYPE', `allocate total must be money, got ${tt}`);
          for (const s of stmt.shares) {
            const st = checkExpr(s.expr, locals);
            if (st !== 'bps') throw err('E_TYPE', `allocate share for '${s.account}' must be bps, got ${st}`);
          }
        }
      }
      const last = fn.body[fn.body.length - 1];
      if (!last || last.kind !== 'return') {
        throw err('E_PARSE', `fee '${fn.name}' must end with a return statement`);
      }
    }
  }
  return contract;
}
