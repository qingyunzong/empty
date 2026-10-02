'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { tmpdir, cleanup } = require('./helpers');

const COMMIT_STEPS = [
  'commit:start',
  'commit:genTmpWritten',
  'commit:genRenamed',
  'commit:headTmpWritten',
  'commit:headRenamed',
  'commit:workingWritten',
];

function build(dir) {
  const engine = Engine.init(dir, { cpus: 4, mem: 16 });
  engine.submit('a', { cpu: 1, mem: 1, bytes: 5, cost: 1, owner: 'x' });
  const c1 = engine.commit();
  engine.submit('b', { cpu: 1, mem: 1, bytes: 7, cost: 1, owner: 'x', deps: ['a'] });
  engine.schedule();
  return { engine, c1 };
}

test('acceptance 4: crash mid-commit recovers all-or-nothing', () => {
  // Reference roots from an uncrashed mirror run.
  const mirror = tmpdir();
  let c1;
  let c2;
  try {
    const m = build(mirror);
    c1 = m.c1;
    c2 = m.engine.commit();
  } finally {
    cleanup(mirror);
  }

  for (const failAt of COMMIT_STEPS) {
    const dir = tmpdir();
    try {
      const built = build(dir);
      assert.strictEqual(built.c1.root, c1.root, 'generation roots are deterministic');

      const crashing = Engine.open(dir, {
        hooks: {
          onStep(step) {
            if (step === failAt) throw new Error('simulated crash');
          },
        },
      });
      assert.throws(() => crashing.commit(), /simulated crash/);

      const recovered = Engine.open(dir);
      const gen = recovered.state.generation;
      assert.ok(gen === 1 || gen === 2, `failAt=${failAt}: generation ${gen}`);
      if (gen === 2) {
        // Commit fully visible: clean state at generation 2.
        assert.strictEqual(recovered.root, c2.root, `failAt=${failAt}`);
        assert.strictEqual(recovered.dirty, false);
        assert.ok(recovered.state.nodes.b);
      } else if (recovered.dirty) {
        // Commit invisible: staged changes survive uncommitted, and
        // recommitting lands exactly the same generation-2 snapshot.
        assert.strictEqual(recovered.commit().root, c2.root, `failAt=${failAt}`);
      } else {
        assert.strictEqual(recovered.root, c1.root, `failAt=${failAt}`);
      }

      const again = Engine.open(dir);
      assert.strictEqual(again.root, recovered.root, 'lineage hash stable across recovery');
    } finally {
      cleanup(dir);
    }
  }
});

test('undo rolls back by commit generation and lineage hashes match', () => {
  const dir = tmpdir();
  try {
    const engine = Engine.init(dir, { cpus: 4, mem: 16 });
    const r0 = engine.root;
    engine.submit('a', { cpu: 1, mem: 1, bytes: 5, cost: 1, owner: 'x' });
    const c1 = engine.commit();
    engine.submit('b', { cpu: 1, mem: 1, bytes: 6, cost: 1, owner: 'x', deps: ['a'] });
    engine.schedule();
    const c2 = engine.commit();
    assert.notStrictEqual(c1.root, c2.root);

    const u1 = engine.undo();
    assert.strictEqual(u1.generation, 1);
    assert.strictEqual(u1.root, c1.root, 'rollback restores generation-1 lineage hash');
    assert.strictEqual(engine.state.nodes.b, undefined);

    const u2 = engine.undo();
    assert.strictEqual(u2.generation, 0);
    assert.strictEqual(u2.root, r0);

    const reopened = Engine.open(dir);
    assert.strictEqual(reopened.root, r0, 'recovered state hash matches rolled-back generation');
    assert.throws(() => reopened.undo(), /no previous generation/);
  } finally {
    cleanup(dir);
  }
});
