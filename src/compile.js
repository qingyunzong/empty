import { LimError, E_TYPE } from './errors.js';

export function applyBin(op, l, r) {
  switch (op) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    case '/': return l / r;
    case '%': return l % r;
    case '<': return l < r ? 1 : 0;
    case '<=': return l <= r ? 1 : 0;
    case '>': return l > r ? 1 : 0;
    case '>=': return l >= r ? 1 : 0;
    case '==': return l === r ? 1 : 0;
    case '!=': return l !== r ? 1 : 0;
    case '&&': return (l && r) ? 1 : 0;
    case '||': return (l || r) ? 1 : 0;
    default: throw new LimError(E_TYPE, `unknown operator '${op}'`);
  }
}

function evalConst(expr, what) {
  switch (expr.k) {
    case 'num': return expr.v;
    case 'un': {
      const v = evalConst(expr.e, what);
      return expr.op === 'neg' ? -v : (v ? 0 : 1);
    }
    case 'bin': return applyBin(expr.op, evalConst(expr.l, what), evalConst(expr.r, what));
    default:
      throw new LimError(E_TYPE, `${what} must be a constant expression, found reference '${expr.path.join('.')}'`);
  }
}

// Compile an expression AST to stack-machine bytecode.
export function compileExpr(e, out = []) {
  switch (e.k) {
    case 'num': out.push(['PUSH', e.v]); break;
    case 'ref': out.push(['LOAD', e.path.join('.')]); break;
    case 'un': compileExpr(e.e, out); out.push([e.op === 'neg' ? 'NEG' : 'NOT']); break;
    case 'bin': compileExpr(e.l, out); compileExpr(e.r, out); out.push(['BIN', e.op]); break;
    default: throw new LimError(E_TYPE, `cannot compile expression node '${e.k}'`);
  }
  return out;
}

function collectRefs(e, acc = []) {
  if (e.k === 'ref') acc.push(e.path);
  else if (e.k === 'un') collectRefs(e.e, acc);
  else if (e.k === 'bin') { collectRefs(e.l, acc); collectRefs(e.r, acc); }
  return acc;
}

function validateRef(path, acctName, strategies) {
  const p = path.join('.');
  if (path.length === 1 && (path[0] === 'capacity' || path[0] === 'used')) return;
  if (path.length === 2 && strategies.has(path[0]) && (path[1] === 'used' || path[1] === 'limit')) return;
  throw new LimError(E_TYPE, `account '${acctName}': unknown reference '${p}' in invariant`);
}

// Statically type-check the parsed spec and compile it to an executable model.
export function compile(spec) {
  const accounts = new Map();
  const orders = new Map();
  for (const a of spec.accounts) {
    if (accounts.has(a.name)) throw new LimError(E_TYPE, `duplicate account '${a.name}'`);
    if (!a.capacityExpr) throw new LimError(E_TYPE, `account '${a.name}' is missing a capacity`);
    const capacity = evalConst(a.capacityExpr, `capacity of account '${a.name}'`);
    if (!Number.isFinite(capacity) || capacity < 0) {
      throw new LimError(E_TYPE, `account '${a.name}': capacity must be a non-negative number`);
    }
    const strategies = new Map();
    let limitSum = 0;
    for (const s of a.strategies) {
      if (strategies.has(s.name)) {
        throw new LimError(E_TYPE, `duplicate strategy '${s.name}' in account '${a.name}'`);
      }
      const limit = evalConst(s.limitExpr, `limit of strategy '${s.name}'`);
      if (!Number.isFinite(limit) || limit < 0) {
        throw new LimError(E_TYPE, `strategy '${s.name}': limit must be a non-negative number`);
      }
      strategies.set(s.name, { name: s.name, limit });
      limitSum += limit;
    }
    if (limitSum > capacity) {
      throw new LimError(E_TYPE,
        `account '${a.name}': strategy sub-limits sum to ${limitSum}, exceeding capacity ${capacity}`);
    }
    for (const inv of a.invariants) {
      for (const ref of collectRefs(inv)) validateRef(ref, a.name, strategies);
    }
    const invariantCode = a.invariants.map((e) => compileExpr(e));
    accounts.set(a.name, { name: a.name, capacity, strategies, invariantCode });
  }
  for (const o of spec.orders) {
    if (orders.has(o.name)) throw new LimError(E_TYPE, `duplicate order '${o.name}'`);
    if (!o.accountName || !o.strategyName || !o.amountExpr) {
      throw new LimError(E_TYPE, `order '${o.name}' must declare account, strategy and amount`);
    }
    const acct = accounts.get(o.accountName);
    if (!acct) throw new LimError(E_TYPE, `order '${o.name}' references unknown account '${o.accountName}'`);
    if (!acct.strategies.has(o.strategyName)) {
      throw new LimError(E_TYPE,
        `order '${o.name}' references unknown strategy '${o.strategyName}' in account '${o.accountName}'`);
    }
    const amount = evalConst(o.amountExpr, `amount of order '${o.name}'`);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new LimError(E_TYPE, `order '${o.name}': amount must be a positive number`);
    }
    orders.set(o.name, { name: o.name, account: o.accountName, strategy: o.strategyName, amount });
  }
  return { accounts, orders };
}
