// Acceptance D: enumerate operation sequences over 2 accounts and cross-check
// invariants, undo-restores-state, and deterministic replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, statesEqual } from '../src/ledger.js';

const BASE_TEMPLATES = [
  { op: 'deposit', account: 'a', amount: 5 },
  { op: 'deposit', account: 'b', amount: 5 },
  { op: 'withdraw', account: 'a', amount: 5 },
  { op: 'withdraw', account: 'b', amount: 5 },
  { op: 'transfer', from: 'a', to: 'b', amount: 5 },
  { op: 'transfer', from: 'b', to: 'a', amount: 5 },
  { op: 'freeze', account: 'a', amount: 5 },
  { op: 'unfreeze', account: 'a', amount: 5 },
  { op: 'undo' },
];
const BATCH_TEMPLATES = [
  { op: 'batchBegin', id: 'BX' },
  { op: 'batchEnd' },
  { op: 'undo', batch: 'BX' },
];

function checkInvariants(state, ctx) {
  for (const [name, acct] of Object.entries(state.accounts)) {
    assert.ok(acct.balance >= 0, `${ctx}: balance>=0 for ${name}`);
    assert.ok(acct.frozen >= 0, `${ctx}: frozen>=0 for ${name}`);
    assert.ok(acct.frozen <= acct.balance, `${ctx}: frozen<=balance for ${name}`);
  }
  assert.ok(state.budget >= 0, `${ctx}: budget>=0`);
}

// Run a sequence, checking invariants after every step and that a successful
// top-level undo restores exactly the state before the undone unit.
function checkSequence(seq) {
  const ledger = new Ledger({ budget: 50 });
  const mirror = []; // stack of states captured before each committed unit
  let prevState = ledger.getState();
  let inBatch = false;
  let preBatchState = null;
  let mirrorEnabled = !seq.some((op) => op.op === 'undo' && op.batch !== undefined);
  const results = [];
  for (const op of seq) {
    const res = ledger.execute(op);
    results.push(res);
    checkInvariants(res.state, JSON.stringify(op));
    if (mirrorEnabled) {
      if (res.status === 'ok') {
        if (op.op === 'undo') {
          const expected = mirror.pop();
          assert.ok(expected, 'undo ok implies non-empty mirror');
          assert.ok(
            statesEqual(ledger.getState(), expected),
            `undo must restore prior state; seq=${JSON.stringify(seq)}`,
          );
        } else if (op.op === 'batchBegin') {
          inBatch = true;
          preBatchState = prevState;
        } else if (op.op === 'batchEnd') {
          mirror.push(preBatchState);
          inBatch = false;
        } else if (!inBatch) {
          mirror.push(prevState);
        }
      } else if (res.status === 'error' && op.op === 'batchEnd') {
        inBatch = false;
      }
    }
    prevState = ledger.getState();
  }
  return results;
}

test('D1: exhaustive sequences of length <= 5 over 9 op templates, 2 accounts', () => {
  const n = BASE_TEMPLATES.length;
  const maxLen = 5;
  let count = 0;
  const idx = new Array(maxLen).fill(0);
  // iterative enumeration of all sequences of exactly maxLen, plus shorter prefixes
  const seq = [];
  function* gen(depth) {
    if (depth === maxLen) return;
    for (let i = 0; i < n; i++) {
      seq.push(BASE_TEMPLATES[i]);
      yield seq;
      yield* gen(depth + 1);
      seq.pop();
    }
  }
  for (const s of gen(0)) {
    checkSequence(s);
    count++;
  }
  assert.equal(count, (n ** (maxLen + 1) - n) / (n - 1)); // 9+81+...+9^5 = 66429
});

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

test('D2: seeded random sequences of length 6..10 incl. batches and batch-undo', () => {
  const templates = [...BASE_TEMPLATES, ...BATCH_TEMPLATES];
  const rand = mulberry32(20261007);
  for (let s = 0; s < 4000; s++) {
    const len = 6 + Math.floor(rand() * 5);
    const seq = [];
    for (let i = 0; i < len; i++) seq.push(templates[Math.floor(rand() * templates.length)]);
    const r1 = checkSequence(seq);
    // deterministic replay: identical inputs produce identical outputs
    const ledger2 = new Ledger({ budget: 50 });
    const r2 = seq.map((op) => ledger2.execute(op));
    assert.deepEqual(
      r1.map((r) => [r.status, r.state, r.error?.code]),
      r2.map((r) => [r.status, r.state, r.error?.code]),
    );
  }
});
