'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const {
  tmpdir,
  cleanup,
  mulberry32,
  bruteForceMaxCompletable,
  assertScheduleValid,
} = require('./helpers');

test('acceptance 1: scheduler completes the max completable set (brute-force cross-check, n<=10)', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const rnd = mulberry32(seed);
    const dir = tmpdir();
    try {
      const quotas = {};
      if (rnd() < 0.7) quotas.alice = 5 + Math.floor(rnd() * 30);
      if (rnd() < 0.7) quotas.bob = 5 + Math.floor(rnd() * 30);
      const engine = Engine.init(dir, { cpus: 4, mem: 16, quotas });
      const n = 2 + Math.floor(rnd() * 9); // 2..10 nodes
      const owners = ['alice', 'bob'];
      const nodes = {};
      for (let i = 0; i < n; i += 1) {
        const id = `n${i}`;
        const depCount = Math.floor(rnd() * Math.min(i, 3));
        const deps = new Set();
        for (let k = 0; k < depCount; k += 1) deps.add(`n${Math.floor(rnd() * i)}`);
        const spec = {
          cpu: 1 + Math.floor(rnd() * 4),
          mem: 1 + Math.floor(rnd() * 8),
          bytes: 1 + Math.floor(rnd() * 10),
          cost: 1 + Math.floor(rnd() * 5),
          owner: owners[Math.floor(rnd() * owners.length)],
          deps: [...deps].sort(),
        };
        engine.submit(id, spec);
        nodes[id] = spec;
      }
      const result = engine.schedule();
      const expected = bruteForceMaxCompletable(nodes, quotas);
      assert.strictEqual(
        result.completed.length,
        expected,
        `seed=${seed}: completed ${result.completed.length}, brute-force max ${expected}`,
      );
      assertScheduleValid(result.events, engine.state);
    } finally {
      cleanup(dir);
    }
  }
});

test('fairness: least completed bytes first; aging prevents starvation', () => {
  const setup = (dir) => {
    const engine = Engine.init(dir, { cpus: 1, mem: 100 });
    engine.submit('a0', { cpu: 1, mem: 1, bytes: 5, cost: 1, owner: 'A' });
    engine.schedule(); // owner A now has 5 completed bytes
    engine.submit('z1', { cpu: 1, mem: 1, bytes: 1, cost: 1, owner: 'A' });
    engine.submit('b1', { cpu: 1, mem: 1, bytes: 0.1, cost: 1, owner: 'B' });
    engine.submit('b2', { cpu: 1, mem: 1, bytes: 0.1, cost: 1, owner: 'B', deps: ['b1'] });
    engine.submit('b3', { cpu: 1, mem: 1, bytes: 0.1, cost: 1, owner: 'B', deps: ['b2'] });
    engine.submit('b4', { cpu: 1, mem: 1, bytes: 0.1, cost: 1, owner: 'B', deps: ['b3'] });
    return engine;
  };
  const startOf = (events, id) => events.find((e) => e.type === 'start' && e.node === id).time;

  // Without aging, B (0 completed bytes) always outranks A (5): z1 starves
  // behind the whole b-chain even though it was ready from t=0.
  const dir1 = tmpdir();
  try {
    const r = setup(dir1).schedule({ agingRate: 0 });
    assert.strictEqual(startOf(r.events, 'b1'), 0, 'least-completed-bytes owner runs first');
    assert.strictEqual(startOf(r.events, 'z1'), 4);
  } finally {
    cleanup(dir1);
  }

  // With aging, z1's wait accumulates while each b-node's wait resets when it
  // becomes ready, so z1 cuts in at t=3 instead of t=4.
  const dir2 = tmpdir();
  try {
    const r = setup(dir2).schedule({ agingRate: 2 });
    assert.strictEqual(startOf(r.events, 'z1'), 3);
    assert.strictEqual(startOf(r.events, 'b4'), 4);
  } finally {
    cleanup(dir2);
  }
});

test('failures are retried until the node succeeds', () => {
  const dir = tmpdir();
  try {
    const engine = Engine.init(dir, { cpus: 2, mem: 10 });
    engine.submit('flaky', { cpu: 1, mem: 1, bytes: 3, cost: 1, owner: 'a', fails: 2 });
    engine.submit('down', { cpu: 1, mem: 1, bytes: 1, cost: 1, owner: 'a', deps: ['flaky'] });
    const r = engine.schedule();
    assert.deepStrictEqual(r.completed, ['down', 'flaky']);
    assert.strictEqual(r.events.filter((e) => e.type === 'fail' && e.node === 'flaky').length, 2);
    assert.strictEqual(engine.state.completedBytes.a, 4);
  } finally {
    cleanup(dir);
  }
});
