import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/parser.js';
import { compile } from '../src/compile.js';
import { check } from '../src/linearize.js';
import { bruteCheck } from '../src/brute.js';
import { typecheckHistory } from '../src/history.js';

// Deterministic PRNG (mulberry32) so the randomized cross-check is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(rand) {
  const capacity = 4 + Math.floor(rand() * 9); // 4..12
  const nStrat = 1 + Math.floor(rand() * 2); // 1..2 strategies
  const names = ['alpha', 'beta'].slice(0, nStrat);
  // split capacity into sub-limits whose sum never exceeds capacity
  const limits = [];
  let remaining = capacity;
  names.forEach((_, i) => {
    const hi = Math.max(1, remaining - (names.length - 1 - i));
    const lim = 1 + Math.floor(rand() * hi);
    limits.push(lim);
    remaining -= lim;
  });
  const specLines = [`account acct { capacity ${capacity};`];
  names.forEach((s, i) => specLines.push(`strategy ${s} { limit ${limits[i]}; }`));
  specLines.push(`invariant ${names.map((s) => `${s}.used`).join(' + ')} <= capacity;`);
  specLines.push('}');
  const nOrders = 1 + Math.floor(rand() * 4); // 1..4 orders
  const orders = [];
  for (let k = 0; k < nOrders; k += 1) {
    const s = names[Math.floor(rand() * names.length)];
    const amount = 1 + Math.floor(rand() * 8);
    orders.push({ name: `o${k}`, strategy: s, amount });
    specLines.push(`order o${k} { account acct; strategy ${s}; amount ${amount}; }`);
  }
  const model = compile(parseSpec(specLines.join('\n')));

  const ops = [];
  let clock = 1;
  let pendingCount = 0;
  const pushOp = (kind, order) => {
    if (ops.length >= 8) return;
    const invoke = clock;
    clock += 1 + Math.floor(rand() * 3);
    const isPending = rand() < 0.15 && pendingCount < 5;
    const op = { id: `op${ops.length}`, kind, order, invoke, response: null, result: null };
    if (isPending) {
      pendingCount += 1;
    } else {
      op.response = invoke + Math.floor(rand() * 3);
      op.result = rand() < 0.5 ? 'ok' : 'fail';
    }
    ops.push(op);
  };
  for (const o of orders) {
    if (rand() < 0.85) {
      pushOp('reserve', o.name);
      if (rand() < 0.15) pushOp('reserve', o.name); // duplicate reserve: second must fail
      if (rand() < 0.4) pushOp('confirm', o.name);
      if (rand() < 0.4) pushOp('release', o.name);
    }
  }
  while (ops.length < 2) pushOp('reserve', orders[Math.floor(rand() * orders.length)].name);
  typecheckHistory(model, ops); // generated histories are always well-typed
  return { model, ops };
}

test('acceptance 4: random histories (n <= 8) match the brute-force permutation reference', () => {
  const SEEDS = 400;
  let linearizableCount = 0;
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const { model, ops } = randomCase(rng(seed * 2654435761));
    assert.ok(ops.length <= 8);
    const fast = check(model, ops, { max: 8 });
    const slow = bruteCheck(model, ops);
    assert.equal(fast.linearizable, slow.linearizable, `seed ${seed} verdict mismatch`);
    assert.deepEqual(fast.orders, slow.orders, `seed ${seed} valid-order mismatch`);
    if (fast.linearizable) linearizableCount += 1;
  }
  // sanity: the random corpus exercises both outcomes
  assert.ok(linearizableCount > 0, 'corpus should contain linearizable histories');
  assert.ok(linearizableCount < SEEDS, 'corpus should contain non-linearizable histories');
});
