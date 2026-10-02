'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { tmpdir, cleanup } = require('./helpers');

function buildPipeline(dir) {
  const engine = Engine.init(dir, { cpus: 8, mem: 64 });
  engine.submit('raw', { bytes: 10, cost: 1, owner: 'a' });
  engine.submit('clean', { bytes: 10, cost: 1, owner: 'a', deps: ['raw'] });
  engine.submit('features', { bytes: 10, cost: 1, owner: 'a', deps: ['clean'] });
  engine.submit('report', { bytes: 10, cost: 1, owner: 'a', deps: ['features'] });
  engine.submit('audit', { bytes: 10, cost: 1, owner: 'b', deps: ['raw'] });
  engine.submit('other', { bytes: 10, cost: 1, owner: 'b' });
  engine.schedule();
  return engine;
}

test('acceptance 2: correcting a parent invalidates exactly the affected subtree', () => {
  const dir = tmpdir();
  try {
    const engine = buildPipeline(dir);
    const affected = engine.correct('clean', { bytes: 12 });
    assert.deepStrictEqual(affected, ['clean', 'features', 'report']);
    // Unaffected nodes keep their materialized evidence.
    assert.strictEqual(engine.state.nodes.raw.status, 'done');
    assert.strictEqual(engine.state.nodes.audit.status, 'done');
    assert.strictEqual(engine.state.nodes.other.status, 'done');
    // Affected nodes are pending again, not "unsatisfiable".
    assert.strictEqual(engine.state.nodes.clean.status, 'pending');
    assert.strictEqual(engine.state.nodes.features.status, 'pending');
    assert.strictEqual(engine.state.nodes.report.status, 'pending');

    const r2 = engine.schedule();
    assert.deepStrictEqual(
      r2.completed,
      ['audit', 'clean', 'features', 'other', 'raw', 'report'],
      'pending dependencies recompute, nothing is treated as unsatisfiable',
    );
    // Only the invalidated subtree is recomputed; untouched nodes never rerun.
    const restarted = r2.events.filter((e) => e.type === 'start').map((e) => e.node).sort();
    assert.deepStrictEqual(restarted, ['clean', 'features', 'report']);
    assert.strictEqual(engine.state.nodes.clean.bytes, 12, 'corrected spec took effect');
  } finally {
    cleanup(dir);
  }
});

test('correcting a leaf invalidates only itself; invalidate() closure is exact', () => {
  const dir = tmpdir();
  try {
    const engine = buildPipeline(dir);
    assert.deepStrictEqual(engine.correct('report', { cost: 3 }), ['report']);
    assert.strictEqual(engine.state.nodes.features.status, 'done');

    const inv = engine.invalidate('raw');
    assert.deepStrictEqual(inv, ['audit', 'clean', 'features', 'raw', 'report']);
    assert.strictEqual(engine.state.nodes.other.status, 'done', 'unrelated subtree untouched');

    const r = engine.schedule();
    assert.deepStrictEqual(r.completed, ['audit', 'clean', 'features', 'other', 'raw', 'report']);
  } finally {
    cleanup(dir);
  }
});
