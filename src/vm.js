import { applyBin } from './compile.js';

// Stack machine for compiled capacity-constraint expressions.
export function evalCode(code, env) {
  const st = [];
  for (const ins of code) {
    switch (ins[0]) {
      case 'PUSH': st.push(ins[1]); break;
      case 'LOAD': st.push(env(ins[1])); break;
      case 'NEG': st.push(-st.pop()); break;
      case 'NOT': st.push(st.pop() ? 0 : 1); break;
      case 'BIN': { const r = st.pop(); const l = st.pop(); st.push(applyBin(ins[1], l, r)); break; }
      default: throw new Error(`bad opcode '${ins[0]}'`);
    }
  }
  return st.pop();
}

// orderState: 0 = none, 1 = reserved, 2 = confirmed, 3 = released.
export function createState(model) {
  const orderState = new Map();
  for (const n of model.orders.keys()) orderState.set(n, 0);
  const acctUsed = new Map();
  const stratUsed = new Map();
  for (const [an, a] of model.accounts) {
    acctUsed.set(an, 0);
    for (const sn of a.strategies.keys()) stratUsed.set(`${an}.${sn}`, 0);
  }
  return { orderState, acctUsed, stratUsed };
}

export function cloneState(s) {
  return {
    orderState: new Map(s.orderState),
    acctUsed: new Map(s.acctUsed),
    stratUsed: new Map(s.stratUsed),
  };
}

function refResolver(model, state, accountName, tentativeUsed, tentativeStrat) {
  const acct = model.accounts.get(accountName);
  return (path) => {
    if (path === 'capacity') return acct.capacity;
    if (path === 'used') return tentativeUsed;
    const [s, field] = path.split('.');
    if (field === 'limit') return acct.strategies.get(s).limit;
    const key = `${accountName}.${s}`;
    return tentativeStrat.has(key) ? tentativeStrat.get(key) : state.stratUsed.get(key);
  };
}

// Execute one operation micro-program against the state.
// Returns true and applies effects on success; returns false and leaves
// the state untouched on failure.
export function runOp(model, state, op) {
  const o = model.orders.get(op.order);
  const os = state.orderState.get(op.order);
  switch (op.kind) {
    case 'reserve': {
      if (os !== 0) return false;
      const acct = model.accounts.get(o.account);
      const newUsed = state.acctUsed.get(o.account) + o.amount;
      if (newUsed > acct.capacity) return false;
      const skey = `${o.account}.${o.strategy}`;
      const newStrat = state.stratUsed.get(skey) + o.amount;
      if (newStrat > acct.strategies.get(o.strategy).limit) return false;
      const env = refResolver(model, state, o.account, newUsed, new Map([[skey, newStrat]]));
      for (const code of acct.invariantCode) {
        if (!evalCode(code, env)) return false;
      }
      state.orderState.set(op.order, 1);
      state.acctUsed.set(o.account, newUsed);
      state.stratUsed.set(skey, newStrat);
      return true;
    }
    case 'confirm': {
      if (os !== 1) return false;
      state.orderState.set(op.order, 2);
      return true;
    }
    case 'release': {
      if (os !== 1) return false;
      state.orderState.set(op.order, 3);
      state.acctUsed.set(o.account, state.acctUsed.get(o.account) - o.amount);
      const skey = `${o.account}.${o.strategy}`;
      state.stratUsed.set(skey, state.stratUsed.get(skey) - o.amount);
      return true;
    }
    default: throw new Error(`bad op kind '${op.kind}'`);
  }
}
