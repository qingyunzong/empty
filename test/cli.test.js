'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execute } = require('../cli.js');

// The CLI is exercised in-process via execute(argv) -> { code, payload },
// which mirrors the real process exit code and the JSON printed to stdout.

function tmpdb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-')), 'db.json');
}

function runOk(db, ...args) {
  const { code, payload } = execute(['--db', db, ...args]);
  assert.equal(code, 0, `expected exit 0, got ${code}: ${JSON.stringify(payload)}`);
  assert.equal(payload.ok, true);
  return payload;
}

test('CLI: full flow with JSON output and exit code conventions', () => {
  const db = tmpdb();

  const budget = runOk(db, 'budget', 'set', 'steel', '1', '100');
  assert.deepEqual(budget, { ok: true, budget: { material: 'steel', day: 1, limit: 100 } });

  const plans = JSON.stringify([
    [{ machine: 'M2', day: 1, material: 'steel', amount: 80 }],
    [{ machine: 'M1', day: 1, material: 'steel', amount: 80 }],
  ]);
  const order = runOk(db, 'order', 'add', 'W1', plans);
  assert.equal(order.order.id, 'W1');

  // dry run does not commit
  const dry = runOk(db, 'plan', 'W1');
  assert.equal(dry.certificate.commitSeq, null);
  assert.equal(dry.certificate.chosen.plan[0].machine, 'M1');
  assert.equal(runOk(db, 'allocations').allocations.length, 0);

  // commit picks the lexicographic minimum and lists compared hashes
  const committed = runOk(db, 'commit', 'W1');
  assert.equal(committed.certificate.chosen.plan[0].machine, 'M1');
  assert.equal(committed.certificate.compared.length, 2);
  const allocs = runOk(db, 'allocations');
  assert.equal(allocs.allocations.length, 1);
  assert.equal(allocs.allocations[0].plan[0].machine, 'M1');

  // state survives across invocations (reload from the db file)
  const state = runOk(db, 'state');
  assert.equal(state.log.length, 3);

  // second order that would overflow the budget -> exit 1 with E_BUDGET JSON
  runOk(db, 'order', 'add', 'W2', JSON.stringify([[{ machine: 'M1', day: 1, material: 'steel', amount: 30 }]]));
  const res = execute(['--db', db, 'commit', 'W2']);
  assert.equal(res.code, 1);
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.error.code, 'E_BUDGET');

  // unknown order -> exit 1
  const missing = execute(['--db', db, 'commit', 'nope']);
  assert.equal(missing.code, 1);
  assert.equal(missing.payload.error.code, 'E_ORDER_NOT_FOUND');

  // usage error -> exit 2
  for (const argv of [['--db', db, 'commit'], ['--db', db, 'bogus'], ['--db', db, 'budget', 'set', 'steel', 'x', '1']]) {
    const bad = execute(argv);
    assert.equal(bad.code, 2, JSON.stringify(bad.payload));
    assert.equal(bad.payload.error.code, 'E_USAGE');
  }
});

test('CLI: enumerate reports feasible assignments and deterministic optimum', () => {
  const db = tmpdb();
  runOk(db, 'budget', 'set', 'steel', '1', '100');
  runOk(db, 'order', 'add', 'W1', JSON.stringify([
    [{ machine: 'M1', day: 1, material: 'steel', amount: 60 }],
    [{ machine: 'M2', day: 1, material: 'steel', amount: 40 }],
  ]));
  runOk(db, 'order', 'add', 'W2', JSON.stringify([
    [{ machine: 'M1', day: 1, material: 'steel', amount: 60 }],
    [{ machine: 'M2', day: 1, material: 'steel', amount: 50 }],
  ]));
  const res = runOk(db, 'enumerate', 'W1,W2');
  // 60+60=120 and 60+50=110 exceed 100; 40+60=100 and 40+50=90 fit
  assert.equal(res.count, 2);
  assert.equal(res.assignments.length, 2);
  assert.deepEqual(res.optimal, res.assignments[0]);

  const tooMany = execute(['--db', db, 'enumerate', 'W1,W2,W1,W2']);
  assert.equal(tooMany.code, 2);
});
