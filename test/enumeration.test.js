'use strict';

// ---------------------------------------------------------------------------
// Acceptance 5: enumerate every request sequence of length <= 6 over a
// representative template set and differentially compare the event-sourced
// core (src/core.js) against the independent serial reference
// (test/reference.js): per-request results and final observable state.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Core } = require('../src/core');
const { runReference } = require('../testlib/reference');

const CONFIG = { budgetLimit: 50, slaMs: 100, highRiskTags: ['high'] };

const TEMPLATES = [
  { op: 'refund', key: 'k1', order: 'o1', amount: 40, riskTag: 'high', paid: 100 }, // 0
  { op: 'refund', key: 'k2', order: 'o1', amount: 40, riskTag: 'high', paid: 100 }, // 1
  { op: 'approve', key: 'k1' },                                                      // 2
  { op: 'reject', key: 'k1' },                                                       // 3
  { op: 'expire', key: 'k1' },                                                       // 4
  { op: 'reverse', key: 'k1' },                                                      // 5
  { op: 'refund', key: 'k3', order: 'o2', amount: 30, riskTag: 'low', paid: 50 },    // 6
  { op: 'refund', key: 'k1', order: 'o1', amount: 99, riskTag: 'high', paid: 100 },  // 7 conflict
];

function runCore(sequence) {
  const core = new Core(CONFIG);
  const results = sequence.map((tpl, i) => core.apply(TEMPLATES[tpl], i * 50));
  const snap = core.snapshot();
  return {
    results,
    snapshot: {
      budgetUsed: snap.budget.used,
      queue: snap.queue,
      refunds: Object.fromEntries(
        Object.entries(snap.refunds).map(([k, r]) => [k, {
          state: r.state, amount: r.amount, budgetHeld: r.budgetHeld,
          rejectCode: r.rejectCode, riskTag: r.riskTag, order: r.order,
        }])
      ),
      orders: snap.orders,
    },
  };
}

function runRef(sequence) {
  const requests = sequence.map((tpl, i) => ({ t: i * 50, op: TEMPLATES[tpl] }));
  return runReference(CONFIG, requests);
}

function compare(sequence) {
  const actual = runCore(sequence);
  const expected = runRef(sequence);
  assert.deepEqual(actual.results, expected.results,
    `results diverge for sequence [${sequence.join(',')}]`);
  assert.deepEqual(actual.snapshot, expected.snapshot,
    `state diverges for sequence [${sequence.join(',')}]`);
}

function* sequences(templates, maxLen) {
  const seq = [];
  function* rec(depth) {
    if (depth > 0) yield [...seq];
    if (depth === maxLen) return;
    for (const t of templates) {
      seq.push(t);
      yield* rec(depth + 1);
      seq.pop();
    }
  }
  yield* rec(0);
}

test('exhaustive <=6-request sequences match the serial reference (6 core templates)', () => {
  let count = 0;
  for (const seq of sequences([0, 1, 2, 3, 4, 5], 6)) {
    compare(seq);
    count++;
  }
  assert.equal(count, 6 + 36 + 216 + 1296 + 7776 + 46656);
});

test('exhaustive <=5-request sequences incl. low-risk and conflict templates', () => {
  let count = 0;
  for (const seq of sequences([0, 1, 2, 3, 4, 5, 6, 7], 5)) {
    compare(seq);
    count++;
  }
  assert.equal(count, 8 + 64 + 512 + 4096 + 32768);
});

test('deterministic 6-request sample over all 8 templates', () => {
  let seed = 0x2f6e2b1;
  const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0xffffffff;
  for (let i = 0; i < 20000; i++) {
    const seq = Array.from({ length: 6 }, () => Math.floor(rand() * 8));
    compare(seq);
  }
});

test('audit hash is deterministic across identical runs', () => {
  const seq = [0, 1, 2, 5, 6, 3];
  const hashOf = () => {
    const c = new Core(CONFIG);
    seq.forEach((t, i) => c.apply(TEMPLATES[t], i * 50));
    return c.auditHash();
  };
  assert.equal(hashOf(), hashOf());
});
