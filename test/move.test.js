'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/simulator');
const Terminal = require('../src/terminal');

// Acceptance 2: MOVE whose new occupancy exceeds the budget keeps the old one.
test('MOVE over budget keeps the old occupancy (atomic rollback)', () => {
  const report = run(
    [
      { op: 'PLAN', id: 'A', ver: 1, cost: 60, start: 8 },
      { op: 'PLAN', id: 'B', ver: 1, cost: 40, start: 9 },
      { op: 'MOVE', id: 'B', ver: 2, cost: 50, start: 10 }, // 60 - 40 + 50... = 60+50=110 > 100
    ],
    { cap: 100 }
  );

  assert.equal(report.ok, false);
  assert.equal(report.failure.type, 'budget');
  assert.equal(report.used, 100, 'state unchanged: old occupancy retained');
  assert.deepEqual(
    report.plan,
    [
      { id: 'A', start: 8, end: null, cost: 60, ver: 1 },
      { id: 'B', start: 9, end: null, cost: 40, ver: 1 },
    ],
    'B still at old position and cost'
  );
  assert.deepEqual(
    report.ledger.map((e) => [e.op, e.id, e.delta, e.used]),
    [
      ['PLAN', 'A', 60, 60],
      ['PLAN', 'B', 40, 100],
    ],
    'no ledger trace of the failed MOVE'
  );
});

test('MOVE within budget releases old and occupies new atomically', () => {
  const t = new Terminal(100);
  t.receive({ op: 'PLAN', id: 'A', ver: 1, cost: 60, start: 8 });
  const ack = t.receive({ op: 'MOVE', id: 'A', ver: 2, cost: 90, start: 12 });
  assert.equal(ack.status, 'ACK');
  assert.equal(t.ledger.used, 90);
  assert.deepEqual(t.ledger.jobs.get('A'), { id: 'A', cost: 90, start: 12, end: null, ver: 2 });
  assert.deepEqual(
    t.ledger.entries.map((e) => [e.op, e.delta, e.used]),
    [
      ['PLAN', 60, 60],
      ['MOVE', -60, 0],
      ['MOVE', 90, 90],
    ]
  );
});

test('MOVE of unknown job is a protocol error', () => {
  const t = new Terminal(100);
  assert.throws(() => t.receive({ op: 'MOVE', id: 'ZZZ', ver: 1, cost: 1 }), /unknown job/);
  assert.equal(t.ledger.used, 0);
});

test('CANCEL releases budget', () => {
  const report = run(
    [
      { op: 'PLAN', id: 'A', ver: 1, cost: 30 },
      { op: 'PLAN', id: 'B', ver: 1, cost: 20 },
      { op: 'CANCEL', id: 'A', ver: 2 },
    ],
    { cap: 100 }
  );
  assert.equal(report.ok, true);
  assert.equal(report.used, 20);
  assert.deepEqual(report.plan.map((j) => j.id), ['B']);
});
