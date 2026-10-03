import { CorpError, E_RATIO } from './errors.js';

// Static type system: every expression has type 'ratio' (share ratio /
// share count, dimensionless) or 'cash'. Mixing cash and ratios in
// additive positions is a static error, as is a split ratio > 1.
export function evalExpr(node) {
  switch (node.kind) {
    case 'num': return { type: 'ratio', value: node.value };
    case 'cash': return { type: 'cash', value: node.value };
    case 'neg': {
      const e = evalExpr(node.expr);
      return { type: e.type, value: -e.value };
    }
    case 'bin': {
      const l = evalExpr(node.left);
      const r = evalExpr(node.right);
      if (node.op === '+' || node.op === '-') {
        if (l.type !== r.type) {
          throw new CorpError(E_RATIO, `cannot ${node.op === '+' ? 'add' : 'subtract'} ${l.type} and ${r.type}: mixing cash and share ratios`);
        }
        return { type: l.type, value: node.op === '+' ? l.value + r.value : l.value - r.value };
      }
      if (node.op === '*') {
        if (l.type === 'cash' && r.type === 'cash') {
          throw new CorpError(E_RATIO, 'cannot multiply cash by cash');
        }
        const type = (l.type === 'cash' || r.type === 'cash') ? 'cash' : 'ratio';
        return { type, value: l.value * r.value };
      }
      // division
      if (r.value === 0) throw new CorpError(E_RATIO, 'division by zero');
      if (l.type === 'ratio' && r.type === 'cash') {
        throw new CorpError(E_RATIO, 'cannot divide a share ratio by cash');
      }
      const type = (l.type === 'cash' && r.type === 'cash') ? 'ratio' : l.type;
      return { type, value: l.value / r.value };
    }
    default:
      throw new CorpError(E_RATIO, `unknown expression node ${node.kind}`);
  }
}

function expectType(v, type, what) {
  if (v.type !== type) {
    throw new CorpError(E_RATIO, `${what} must be a ${type} expression, got ${v.type}`);
  }
}

function checkAction(action) {
  if (action.kind === 'split') {
    const r = evalExpr(action.ratio);
    expectType(r, 'ratio', 'split ratio');
    // A split is written as old:new, e.g. `split 1/2` doubles the shares.
    // A ratio > 1 would silently destroy shares, so it is rejected statically.
    if (!(r.value > 0 && r.value <= 1)) {
      throw new CorpError(E_RATIO, `split ratio must be in (0, 1], got ${r.value}`);
    }
    return { ratio: r.value };
  }
  if (action.kind === 'dividend') {
    const a = evalExpr(action.amount);
    expectType(a, 'cash', 'dividend amount');
    if (a.value < 0) throw new CorpError(E_RATIO, `dividend amount must be >= 0, got ${a.value}`);
    return { amount: a.value };
  }
  if (action.kind === 'tender') {
    const p = evalExpr(action.price);
    expectType(p, 'cash', 'tender price');
    if (p.value < 0) throw new CorpError(E_RATIO, `tender price must be >= 0, got ${p.value}`);
    const f = evalExpr(action.fraction);
    expectType(f, 'ratio', 'tender fraction');
    if (!(f.value > 0 && f.value <= 1)) {
      throw new CorpError(E_RATIO, `tender fraction must be in (0, 1], got ${f.value}`);
    }
    return { price: p.value, fraction: f.value };
  }
  throw new CorpError(E_RATIO, `unknown action kind ${action.kind}`);
}

// Annotates each statement with constant-evaluated params (stmt.params).
export function check(stmts) {
  for (const st of stmts) {
    if (st.type === 'APPLY' || st.type === 'RESTATED') {
      st.params = checkAction(st.action);
    } else if (st.type === 'SELL') {
      const q = evalExpr(st.qty);
      expectType(q, 'ratio', 'sell quantity');
      if (!(q.value > 0)) throw new CorpError(E_RATIO, `sell quantity must be > 0, got ${q.value}`);
      st.params = { qty: q.value };
    }
  }
  return stmts;
}
