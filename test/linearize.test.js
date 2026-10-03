import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/limit.js';
import { checkLinearizable } from '../src/linearize.js';

function expectedError(entry) {
  if (entry.result === undefined || entry.result === 'ok') return null;
  return entry.result;
}

function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) out.push([items[i], ...perm]);
  }
  return out;
}

// Brute-force oracle: try every permutation of the entries (ignoring
// real-time precedence, which is empty when all intervals overlap) and
// check whether any permutation serializes legally with the recorded
// results.
function bruteForceLinearizable(entries, defaultLimit) {
  return permutations(entries).some((perm) => {
    const ledger = new Ledger(defaultLimit);
    return perm.every((entry) => {
      const want = expectedError(entry);
      try {
        ledger.apply(entry);
        return want === null;
      } catch (err) {
        return want !== null && err.code === want;
      }
    });
  });
}

// Fully concurrent entries: all share the same [0, 0] interval, so no
// real-time precedence constrains the checker.
function concurrent(ops) {
  return ops.map((op, i) => ({ id: 'op' + i, start: 0, end: 0, ...op }));
}

const LIMIT = 100;

const scenarios = {
  'two freezes fit, third does not': {
    entries: concurrent([
      { op: 'freeze', authId: 'a1', acc: 'x', amount: 60, ttl: 10000, time: 0, result: 'ok' },
      { op: 'freeze', authId: 'a2', acc: 'x', amount: 60, ttl: 10000, time: 0, result: 'E_LIMIT' },
      { op: 'freeze', authId: 'a3', acc: 'x', amount: 40, ttl: 10000, time: 0, result: 'ok' },
    ]),
  },
  'three freezes all ok is impossible': {
    entries: concurrent([
      { op: 'freeze', authId: 'a1', acc: 'x', amount: 60, ttl: 10000, time: 0, result: 'ok' },
      { op: 'freeze', authId: 'a2', acc: 'x', amount: 60, ttl: 10000, time: 0, result: 'ok' },
      { op: 'freeze', authId: 'a3', acc: 'x', amount: 40, ttl: 10000, time: 0, result: 'ok' },
    ]),
  },
  'freeze, partial capture, release': {
    entries: concurrent([
      { op: 'capture', authId: 'a1', amount: 10, time: 0, result: 'ok' },
      { op: 'freeze', authId: 'a1', acc: 'x', amount: 50, ttl: 10000, time: 0, result: 'ok' },
      { op: 'release', authId: 'a1', time: 0, result: 'ok' },
    ]),
  },
  'capture before freeze fails with E_STATE': {
    entries: concurrent([
      { op: 'capture', authId: 'a1', amount: 10, time: 0, result: 'E_STATE' },
      { op: 'freeze', authId: 'a1', acc: 'x', amount: 50, ttl: 10000, time: 0, result: 'ok' },
      { op: 'release', authId: 'a1', time: 0, result: 'ok' },
    ]),
  },
  'freeze reported E_STATE is impossible': {
    entries: concurrent([
      { op: 'capture', authId: 'a1', amount: 10, time: 0, result: 'ok' },
      { op: 'freeze', authId: 'a1', acc: 'x', amount: 50, ttl: 10000, time: 0, result: 'E_STATE' },
      { op: 'release', authId: 'a1', time: 0, result: 'ok' },
    ]),
  },
  'expired capture observed as E_EXPIRED': {
    entries: concurrent([
      { op: 'freeze', authId: 'a1', acc: 'x', amount: 50, ttl: 100, time: 0, result: 'ok' },
      { op: 'capture', authId: 'a1', amount: 10, time: 100, result: 'E_EXPIRED' },
      { op: 'freeze', authId: 'a2', acc: 'x', amount: 90, ttl: 10000, time: 100, result: 'ok' },
    ]),
  },
};

for (const [name, scenario] of Object.entries(scenarios)) {
  test('C: checker agrees with exhaustive 3-op permutations: ' + name, () => {
    const oracle = bruteForceLinearizable(scenario.entries, LIMIT);
    const outcome = checkLinearizable(scenario.entries, { defaultLimit: LIMIT });
    assert.equal(outcome.linearizable, oracle);
    if (oracle) {
      // Replay the witness and confirm it reproduces every recorded result.
      const byId = new Map(scenario.entries.map((entry) => [entry.id, entry]));
      const ledger = new Ledger(LIMIT);
      for (const id of outcome.witness) {
        const entry = byId.get(id);
        const want = expectedError(entry);
        if (want === null) ledger.apply(entry);
        else assert.throws(() => ledger.apply(entry), (err) => err.code === want);
      }
      assert.equal(outcome.witness.length, scenario.entries.length);
    } else {
      assert.equal(outcome.witness, undefined);
    }
  });
}

test('C: real-time precedence constrains the serial order', () => {
  // op1 (freeze 60) completes before op2 (freeze 60) starts, and op2
  // completes before op3 (release) starts: forced order op1, op2, op3.
  const base = [
    { id: 'op1', op: 'freeze', authId: 'a1', acc: 'x', amount: 60, ttl: 10000, time: 0, start: 0, end: 2 },
    { id: 'op2', op: 'freeze', authId: 'a2', acc: 'x', amount: 60, ttl: 10000, time: 3, start: 3, end: 5 },
    { id: 'op3', op: 'release', authId: 'a1', time: 6, start: 6, end: 8 },
  ];
  const accepted = checkLinearizable(
    base.map((entry, i) => ({ ...entry, result: i === 1 ? 'E_LIMIT' : 'ok' })),
    { defaultLimit: LIMIT },
  );
  assert.equal(accepted.linearizable, true);
  assert.deepEqual(accepted.witness, ['op1', 'op2', 'op3']);

  // Recording op2 as ok contradicts the forced order (60 + 60 > 100 while
  // a1 is still frozen), so the log must be rejected.
  const rejected = checkLinearizable(
    base.map((entry) => ({ ...entry, result: 'ok' })),
    { defaultLimit: LIMIT },
  );
  assert.equal(rejected.linearizable, false);
});

test('C: witness respects precedence when multiple orders are legal', () => {
  const entries = [
    { id: 'op1', op: 'freeze', authId: 'a1', acc: 'x', amount: 30, ttl: 10000, time: 0, start: 0, end: 1, result: 'ok' },
    { id: 'op2', op: 'freeze', authId: 'a2', acc: 'x', amount: 30, ttl: 10000, time: 2, start: 2, end: 3, result: 'ok' },
    { id: 'op3', op: 'freeze', authId: 'a3', acc: 'x', amount: 30, ttl: 10000, time: 2, start: 2, end: 3, result: 'ok' },
  ];
  const outcome = checkLinearizable(entries, { defaultLimit: LIMIT });
  assert.equal(outcome.linearizable, true);
  assert.ok(outcome.witness.indexOf('op1') < outcome.witness.indexOf('op2'));
  assert.ok(outcome.witness.indexOf('op1') < outcome.witness.indexOf('op3'));
});
