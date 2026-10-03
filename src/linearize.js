import { LimError } from './errors.js';
import { compile } from './compile.js';
import { run } from './vm.js';

// Hard cap on enumerated interleavings: beyond this we report E_BOUND
// instead of silently misjudging.
export const MAX_ORDERS = 1_000_000;

// a must precede b if a's response is known and no later than b's invoke
// (real-time order), or if a's logical clock is strictly smaller.
function precedes(a, b) {
  if (a.response !== null && a.response <= b.invoke) return true;
  if (a.clock !== null && b.clock !== null && a.clock < b.clock) return true;
  return false;
}

function* topologicalOrders(n, edgesBefore) {
  const indeg = new Array(n).fill(0);
  const succ = Array.from({ length: n }, () => []);
  for (const [a, b] of edgesBefore) { succ[a].push(b); indeg[b]++; }
  const order = [];
  const used = new Array(n).fill(false);
  let count = 0;
  function* gen() {
    if (order.length === n) { count++; yield [...order]; return; }
    for (let v = 0; v < n; v++) {
      if (used[v] || indeg[v] !== 0) continue;
      used[v] = true; order.push(v);
      for (const w of succ[v]) indeg[w]--;
      yield* gen();
      for (const w of succ[v]) indeg[w]++;
      used[v] = false; order.pop();
      if (count > MAX_ORDERS) return;
    }
  }
  yield* gen();
}

function compareIdSeq(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// Decide whether the history is linearizable against the spec.
// Returns { status: 'OK'|'PENDING'|'E_LINEAR', orders: [[id,...]], pending: [id] }.
// Throws LimError with code E_BOUND when the scale exceeds the limit.
export function checkLinearizable(spec, ops, { max = 8 } = {}) {
  const n = ops.length;
  if (n > max) {
    throw new LimError('E_BOUND', `history has ${n} operations, exceeds --max ${max}`);
  }
  const program = compile(spec, ops);

  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && precedes(ops[i], ops[j])) edges.push([i, j]);
    }
  }

  const pending = ops.filter(o => o.result === 'pending').map(o => o.id);
  const valid = [];
  let explored = 0;
  for (const order of topologicalOrders(n, edges)) {
    explored++;
    if (explored > MAX_ORDERS) {
      throw new LimError('E_BOUND', `more than ${MAX_ORDERS} interleavings to explore`);
    }
    const results = run(program, order);
    let match = true;
    for (let k = 0; k < n; k++) {
      const op = ops[k];
      if (op.result === 'pending') continue; // PENDING is never treated as failure
      if (results.get(op.id) !== op.result) { match = false; break; }
    }
    if (match) valid.push(order.map(i => ops[i].id));
  }
  valid.sort(compareIdSeq);
  const status = valid.length === 0 ? 'E_LINEAR' : pending.length > 0 ? 'PENDING' : 'OK';
  return { status, orders: valid, pending, explored };
}
