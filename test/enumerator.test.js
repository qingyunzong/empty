import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findWitness } from '../src/linearize.js';
import { bruteForceLinearizable } from '../src/enumerator.js';
import { validateHistory } from '../src/validate.js';

// Deterministic PRNG (mulberry32) so the cross-validation is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHistory(rand) {
  const nHolds = 1 + Math.floor(rand() * 2);
  const ops = [];
  let clock = 1;
  for (let h = 0; h < nHolds; h++) {
    const holdId = `H${h}`;
    const amount = 1 + Math.floor(rand() * 6);
    const invoke = Math.floor(rand() * 3);
    const respond = invoke + Math.floor(rand() * 2);
    ops.push({
      id: `h${h}`, op: 'hold', holdId, amount, deadline: 8,
      invoke, respond, clock: clock++, version: 1,
    });
    const nOps = Math.floor(rand() * 5);
    for (let k = 0; k < nOps; k++) {
      const inv = Math.floor(rand() * 8);
      const res = inv + Math.floor(rand() * 2);
      const kind = rand();
      const id = `h${h}o${k}`;
      if (kind < 0.45) {
        ops.push({
          id, op: 'capture', holdId,
          amount: 1 + Math.floor(rand() * 3),
          captured: Math.floor(rand() * (amount + 2)),
          invoke: inv, respond: res, clock: clock++, version: 1,
        });
      } else if (kind < 0.7) {
        ops.push({ id, op: 'cancel', holdId, invoke: inv, respond: res, clock: clock++, version: 1 });
      } else {
        ops.push({
          id, op: 'audit', holdId,
          result: {
            frozen: Math.floor(rand() * (amount + 1)),
            captured: Math.floor(rand() * (amount + 1)),
            available: Math.floor(rand() * (amount + 1)),
          },
          invoke: inv, respond: res, clock: clock++, version: 1,
        });
      }
    }
  }
  // Keep at most 6 operations so the brute-force enumerator can check them.
  return { operations: ops.slice(0, 6) };
}

test('checker and independent enumerator agree on 400 random small histories', () => {
  const rand = rng(20261002);
  let linearizableCount = 0;
  for (let i = 0; i < 400; i++) {
    const history = randomHistory(rand);
    let ops;
    try {
      ops = validateHistory(history);
    } catch {
      continue; // skip invalid draws; validation is tested separately
    }
    const expected = bruteForceLinearizable(ops).linearizable;
    const actual = findWitness(history) !== null;
    assert.equal(actual, expected, `disagreement on history ${i}: ${JSON.stringify(history)}`);
    if (actual) linearizableCount++;
  }
  // Sanity: the sample must contain both outcomes to be a meaningful check.
  assert.ok(linearizableCount > 20, `too few linearizable samples: ${linearizableCount}`);
  assert.ok(linearizableCount < 380, `too few non-linearizable samples: ${linearizableCount}`);
});

test('enumerator confirms every hand-written acceptance witness', () => {
  const cases = [
    [ // partial capture, cancel, audit of the remainder release
      { id: 'h1', op: 'hold', holdId: 'H1', amount: 5, deadline: 9, invoke: 0, respond: 1, clock: 1, version: 1 },
      { id: 'c1', op: 'capture', holdId: 'H1', amount: 2, captured: 2, invoke: 2, respond: 3, clock: 2, version: 1 },
      { id: 'x1', op: 'cancel', holdId: 'H1', invoke: 4, respond: 5, clock: 3, version: 1 },
      { id: 'a1', op: 'audit', holdId: 'H1', result: { frozen: 0, captured: 2, available: 0 }, invoke: 6, respond: 7, clock: 4, version: 1 },
    ],
    [ // overlapping audit reading the pre-capture state
      { id: 'h1', op: 'hold', holdId: 'H1', amount: 4, deadline: 9, invoke: 0, respond: 1, clock: 1, version: 1 },
      { id: 'c1', op: 'capture', holdId: 'H1', amount: 3, captured: 3, invoke: 2, respond: 6, clock: 2, version: 1 },
      { id: 'a1', op: 'audit', holdId: 'H1', result: { frozen: 4, captured: 0, available: 4 }, invoke: 3, respond: 4, clock: 3, version: 1 },
    ],
  ];
  for (const ops of cases) {
    const validated = validateHistory({ operations: ops });
    assert.equal(bruteForceLinearizable(validated).linearizable, true);
    assert.ok(findWitness({ operations: ops }));
  }
});

test('enumerator confirms capture-after-cancel is impossible', () => {
  const ops = validateHistory({
    operations: [
      { id: 'h1', op: 'hold', holdId: 'H1', amount: 4, deadline: 9, invoke: 0, respond: 1, clock: 1, version: 1 },
      { id: 'x1', op: 'cancel', holdId: 'H1', invoke: 2, respond: 3, clock: 2, version: 1 },
      { id: 'c1', op: 'capture', holdId: 'H1', amount: 1, captured: 1, invoke: 4, respond: 5, clock: 3, version: 1 },
    ],
  });
  assert.equal(bruteForceLinearizable(ops).linearizable, false);
});
