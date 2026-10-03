import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/parser.js';
import { checkSpec } from '../src/check.js';
import { checkHistory } from '../src/history.js';
import { checkLinearizable } from '../src/linearize.js';
import { LimError } from '../src/errors.js';
import { refValidOrders, mulberry32 } from './reference.js';

function run(specSrc, historyJson, opts) {
  const spec = checkSpec(parseSpec(specSrc));
  const ops = checkHistory(spec, historyJson);
  return checkLinearizable(spec, ops, opts);
}

// Acceptance 1: three concurrent operations, one success one failure.
test('three concurrent ops: one ok, one fail, all valid orders listed lexicographically', () => {
  const spec = `
    account A {
      capacity 10
      strategy s1 { quota 10 }
    }`;
  const history = [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 6, invoke: 0, response: 10, result: 'ok' },
    { id: 'r2', kind: 'reserve', account: 'A', strategy: 's1', amount: 6, invoke: 1, response: 9, result: 'fail' },
    { id: 'r3', kind: 'reserve', account: 'A', strategy: 's1', amount: 4, invoke: 2, response: 8, result: 'ok' },
  ];
  const v = run(spec, history);
  assert.equal(v.status, 'OK');
  // r2 (fail) must observe r1's 6 units held; r3's 4 alone would still leave room.
  assert.deepEqual(v.orders, [
    ['r1', 'r2', 'r3'],
    ['r1', 'r3', 'r2'],
    ['r3', 'r1', 'r2'],
  ]);
});

// Acceptance 2: PENDING participates and is never treated as failure.
test('pending op is not treated as failure and not rejected outright', () => {
  const spec = `
    account A {
      capacity 10
      strategy s1 { quota 10 }
    }`;
  const history = [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 8, invoke: 0, response: 5, result: 'ok' },
    { id: 'r2', kind: 'reserve', account: 'A', strategy: 's1', amount: 8, invoke: 1, response: null, result: 'pending' },
  ];
  const v = run(spec, history);
  assert.equal(v.status, 'PENDING');
  assert.deepEqual(v.pending, ['r2']);
  assert.deepEqual(v.orders, [['r1', 'r2']]);
});

test('pending op effects are considered: linearizable only if pending reserve succeeded', () => {
  const spec = `
    account A {
      capacity 10
      strategy s1 { quota 10 }
    }`;
  // x1 (release of r2) observed ok => r2 must have succeeded somewhere before it,
  // and r1 (ok) only fits after r2 is released. Treating r2 as failed would
  // wrongly reject this history.
  const history = [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 6, invoke: 0, response: 100, result: 'ok' },
    { id: 'r2', kind: 'reserve', account: 'A', strategy: 's1', amount: 6, invoke: 1, response: null, result: 'pending' },
    { id: 'x1', kind: 'release', target: 'r2', invoke: 2, response: 101, result: 'ok' },
  ];
  const v = run(spec, history);
  assert.equal(v.status, 'PENDING');
  assert.deepEqual(v.orders, [['r2', 'x1', 'r1']]);
});

// Acceptance 3: duplicate release is a static type error.
test('duplicate release of the same reserve raises E_TYPE', () => {
  const spec = `
    account A {
      capacity 10
      strategy s1 { quota 10 }
    }`;
  const history = [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 3, invoke: 0, response: 1, result: 'ok' },
    { id: 'x1', kind: 'release', target: 'r1', invoke: 2, response: 3, result: 'ok' },
    { id: 'x2', kind: 'release', target: 'r1', invoke: 4, response: 5, result: 'fail' },
  ];
  assert.throws(() => run(spec, history), (e) => e instanceof LimError && e.code === 'E_TYPE');
});

// Acceptance 4: random histories with n <= 8 cross-checked against a
// brute-force permutation reference that shares no code with the library.
test('random histories (n <= 8) match brute-force reference', () => {
  const rand = mulberry32(20261003);
  const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  for (let trial = 0; trial < 40; trial++) {
    const nStrat = ri(1, 3);
    const stratNames = Array.from({ length: nStrat }, (_, i) => `s${i}`);
    const capacity = ri(6, 16);
    const quotas = {};
    let remaining = capacity;
    for (let i = 0; i < nStrat; i++) {
      const q = i === nStrat - 1 ? Math.max(1, remaining) : ri(1, Math.max(1, remaining - (nStrat - i - 1)));
      quotas[stratNames[i]] = q;
      remaining -= q;
    }
    // Random extra constraint: sum of a subset of used() <= K.
    const subset = stratNames.filter(() => rand() < 0.7);
    const constraintK = ri(4, capacity + 4);
    const constraint = subset.length > 0
      ? (used) => subset.reduce((acc, s) => acc + used.get(s), 0) <= constraintK
      : () => true;
    const constraintText = subset.length > 0
      ? `constraint ${subset.map(s => `used(${s})`).join(' + ')} <= ${constraintK}`
      : '';
    const specSrc = `
      account A {
        capacity ${capacity}
        ${stratNames.map(s => `strategy ${s} { quota ${quotas[s]} }`).join('\n')}
        ${constraintText}
      }`;

    const n = ri(1, 8);
    const ops = [];
    const reserveIds = [];
    const releasedTargets = new Set();
    const confirmedTargets = new Set();
    for (let i = 0; i < n; i++) {
      const invoke = ri(0, 12);
      const isPending = rand() < 0.2;
      const response = isPending ? null : invoke + ri(0, 6);
      const result = isPending ? 'pending' : (rand() < 0.6 ? 'ok' : 'fail');
      const clock = rand() < 0.4 ? ri(0, 10) : null;
      const canConsume = reserveIds.length > 0 && rand() < 0.35;
      if (canConsume) {
        const target = reserveIds[ri(0, reserveIds.length - 1)];
        const kind = rand() < 0.5 ? 'release' : 'confirm';
        const seen = kind === 'release' ? releasedTargets : confirmedTargets;
        if (seen.has(target)) { i--; continue; }
        seen.add(target);
        ops.push({ id: `c${i}`, kind, target, invoke, response, result, ...(clock !== null ? { clock } : {}) });
      } else {
        const id = `r${i}`;
        reserveIds.push(id);
        ops.push({
          id, kind: 'reserve', account: 'A',
          strategy: stratNames[ri(0, nStrat - 1)], amount: ri(1, 10),
          invoke, response, result, ...(clock !== null ? { clock } : {}),
        });
      }
    }

    const spec = checkSpec(parseSpec(specSrc));
    const checked = checkHistory(spec, ops);
    const got = checkLinearizable(spec, checked, { max: 8 });
    const want = refValidOrders({ capacity, quotas, constraint }, checked);
    assert.deepEqual(got.orders, want, `trial ${trial} mismatch\nspec:\n${specSrc}\nops: ${JSON.stringify(ops)}`);
    const expectedStatus = want.length === 0 ? 'E_LINEAR'
      : checked.some(o => o.result === 'pending') ? 'PENDING' : 'OK';
    assert.equal(got.status, expectedStatus, `trial ${trial} status`);
  }
});

// Acceptance 5: beyond the scale bound the checker reports E_BOUND, not a guess.
test('history larger than --max yields E_BOUND', () => {
  const spec = `
    account A {
      capacity 1000
      strategy s1 { quota 1000 }
    }`;
  const history = Array.from({ length: 9 }, (_, i) => ({
    id: `r${i}`, kind: 'reserve', account: 'A', strategy: 's1', amount: 1,
    invoke: i, response: i + 1, result: 'ok',
  }));
  assert.throws(() => run(spec, history, { max: 8 }), (e) => e instanceof LimError && e.code === 'E_BOUND');
});
