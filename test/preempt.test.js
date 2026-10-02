'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { tmpdir, cleanup } = require('./helpers');

test('acceptance 3: preemption recomputes without double-charging owner quota', () => {
  const dir = tmpdir();
  try {
    const engine = Engine.init(dir, { cpus: 2, mem: 16, quotas: { a: 100 } });
    engine.submit('parent', { cpu: 1, mem: 1, bytes: 10, cost: 6, owner: 'a' });
    engine.submit('child', { cpu: 1, mem: 1, bytes: 5, cost: 2, owner: 'a', deps: ['parent'] });

    const r = engine.schedule({ preempt: ['parent'] });
    assert.strictEqual(r.events.filter((e) => e.type === 'preempt').length, 1);
    assert.strictEqual(
      r.events.filter((e) => e.type === 'end' && e.node === 'parent').length,
      1,
      'parent completes exactly once despite preemption',
    );
    assert.deepStrictEqual(r.completed, ['child', 'parent']);

    // Quota ledger: each node charged exactly once, children included.
    assert.strictEqual(engine.state.ledger.parent, 10);
    assert.strictEqual(engine.state.ledger.child, 5);
    assert.strictEqual(engine.state.completedBytes.a, 15);

    // Invalidate the subtree and recompute: still no extra quota consumed.
    engine.invalidate('parent');
    const r2 = engine.schedule();
    assert.deepStrictEqual(r2.completed, ['child', 'parent']);
    assert.strictEqual(engine.state.completedBytes.a, 15, 'recompute is quota-free');
    assert.strictEqual(Object.keys(engine.state.ledger).length, 2);
  } finally {
    cleanup(dir);
  }
});

test('preemption only kills recomputable nodes and preserves materialized evidence', () => {
  const dir = tmpdir();
  try {
    const engine = Engine.init(dir, { cpus: 2, mem: 10 });
    engine.submit('golden', { cpu: 1, mem: 1, bytes: 9, cost: 4, owner: 'a', recomputable: false });
    engine.schedule();
    assert.strictEqual(engine.state.nodes.golden.status, 'done');

    const kept = engine.preempt('golden');
    assert.deepStrictEqual(kept, { id: 'golden', preempted: false, preserved: true });
    assert.strictEqual(engine.state.nodes.golden.status, 'done', 'materialized evidence kept');

    engine.state.nodes.golden.status = 'running'; // simulate in-flight run
    assert.throws(() => engine.preempt('golden'), /not recomputable/);
  } finally {
    cleanup(dir);
  }
});
