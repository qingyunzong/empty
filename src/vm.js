// Sequential VM: executes one candidate interleaving (a permutation of the
// compiled instruction stream) and reports ok/fail per operation. The VM
// itself never runs concurrently; the checker enumerates interleavings.

function evalExpr(bytecode, account, state, delta) {
  const stack = [];
  const usedOf = (s) => state.used.get(s) + (delta && delta.strategy === s ? delta.amount : 0);
  for (const [op, arg] of bytecode) {
    switch (op) {
      case 'CONST': stack.push(arg); break;
      case 'CAP': stack.push(account.capacity); break;
      case 'USED': stack.push(usedOf(arg)); break;
      case 'QUOTA': stack.push(account.quotas.get(arg)); break;
      case 'NEG': stack.push(-stack.pop()); break;
      case 'ADD': { const b = stack.pop(), a = stack.pop(); stack.push(a + b); break; }
      case 'SUB': { const b = stack.pop(), a = stack.pop(); stack.push(a - b); break; }
      case 'MUL': { const b = stack.pop(), a = stack.pop(); stack.push(a * b); break; }
      case 'LE': { const b = stack.pop(), a = stack.pop(); stack.push(a <= b); break; }
      case 'LT': { const b = stack.pop(), a = stack.pop(); stack.push(a < b); break; }
      case 'GE': { const b = stack.pop(), a = stack.pop(); stack.push(a >= b); break; }
      case 'GT': { const b = stack.pop(), a = stack.pop(); stack.push(a > b); break; }
      case 'EQ': { const b = stack.pop(), a = stack.pop(); stack.push(a === b); break; }
      case 'NE': { const b = stack.pop(), a = stack.pop(); stack.push(a !== b); break; }
      default: throw new Error(`bad bytecode op '${op}'`);
    }
  }
  return stack.pop();
}

export function run(program, order) {
  const states = new Map();
  for (const [name, account] of program.accounts) {
    states.set(name, {
      account,
      used: new Map([...account.quotas.keys()].map(s => [s, 0])),
      total: 0,
    });
  }
  const reserves = new Map(); // reserveId -> {account, strategy, amount, state}
  const results = new Map();

  for (const idx of order) {
    const instr = program.instrs[idx];
    let ok = false;
    if (instr.code === 'RESERVE') {
      const st = states.get(instr.account);
      const acc = st.account;
      const delta = { strategy: instr.strategy, amount: instr.amount };
      const withinAccount = st.total + instr.amount <= acc.capacity;
      const withinQuota = st.used.get(instr.strategy) + instr.amount <= acc.quotas.get(instr.strategy);
      const constraintsHold = acc.constraints.every(bc => evalExpr(bc, acc, st, delta) === true);
      if (withinAccount && withinQuota && constraintsHold) {
        st.used.set(instr.strategy, st.used.get(instr.strategy) + instr.amount);
        st.total += instr.amount;
        reserves.set(instr.id, { account: instr.account, strategy: instr.strategy, amount: instr.amount, state: 'active' });
        ok = true;
      }
    } else {
      const r = reserves.get(instr.target);
      if (r && r.state === 'active') {
        const st = states.get(r.account);
        st.used.set(r.strategy, st.used.get(r.strategy) - r.amount);
        st.total -= r.amount;
        r.state = instr.code === 'CONFIRM' ? 'confirmed' : 'released';
        ok = true;
      }
    }
    results.set(instr.id, ok ? 'ok' : 'fail');
  }
  return results;
}
