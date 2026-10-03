'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Genealogy, GenealogyError } = require('../src/genealogy');
const { buildReference, mulberry32 } = require('../testutil/reference');

function assembly() {
  const g = new Genealogy();
  for (const id of ['A', 'B', 'C']) g.define(id, 'input');
  for (const id of ['P', 'Q']) g.define(id, 'output');
  g.transform('P', ['A', 'B']);
  g.transform('Q', ['P', 'C']);
  return g;
}

test('multi-level assembly: forward blocking propagates and release clears it', () => {
  const g = assembly();
  const diff = g.hold('A');
  assert.equal(g.query('P').status, 'held');
  assert.equal(g.query('Q').status, 'held');
  assert.deepEqual(g.query('Q').blockReasons, ['A']);
  assert.deepEqual(g.query('Q').paths, [['A', 'P', 'Q']]);
  const changed = diff.batches.changed.map((c) => [c.batch, c.from.status, c.to.status]);
  assert.deepEqual(changed, [
    ['A', 'released', 'held'],
    ['P', 'released', 'held'],
    ['Q', 'released', 'held'],
  ]);

  g.release('A');
  assert.equal(g.query('P').status, 'released');
  assert.equal(g.query('Q').status, 'released');
  assert.deepEqual(g.query('Q').blockReasons, []);
  assert.deepEqual(g.query('Q').paths, []);
});

test('shipped batch keeps shipped status but certificate lists risk paths', () => {
  const g = assembly();
  g.ship('Q');
  g.hold('A');
  const cert = g.query('Q');
  assert.equal(cert.status, 'shipped');
  assert.equal(cert.blocked, false);
  assert.deepEqual(cert.blockReasons, ['A']);
  assert.deepEqual(cert.paths, [['A', 'P', 'Q']]);
  assert.equal(g.query('P').status, 'held');
});

test('multiple held sources yield one deterministic path per source-to-target route', () => {
  const g = assembly();
  g.hold('C');
  g.hold('A');
  const cert = g.query('Q');
  assert.deepEqual(cert.blockReasons, ['A', 'C']);
  assert.deepEqual(cert.paths, [
    ['A', 'P', 'Q'],
    ['C', 'Q'],
  ]);
});

test('correct parent: diff shows old/new genealogy, undo restores exactly', () => {
  const g = new Genealogy();
  g.define('A', 'input');
  g.define('B', 'input');
  g.define('P', 'output');
  g.transform('P', ['A']);
  g.hold('A');
  const before = g.snapshots[g.snapshots.length - 1];
  const beforeVersion = g.version;

  const diff = g.correct(3, { op: 'transform', output: 'P', inputs: ['B'] });
  assert.deepEqual(diff.edges.removed, [{ output: 'P', input: 'A' }]);
  assert.deepEqual(diff.edges.added, [{ output: 'P', input: 'B' }]);
  assert.equal(g.query('P').status, 'released');
  assert.deepEqual(g.query('P').blockReasons, []);

  g.hold('B');
  assert.deepEqual(g.query('P').blockReasons, ['B']);
  assert.deepEqual(g.query('P').paths, [['B', 'P']]);

  g.undo(); // undo hold B
  g.undo(); // undo correct
  assert.ok(g.version > beforeVersion); // undo is itself a new version
  assert.deepEqual(g.snapshots[g.snapshots.length - 1], before);
  assert.deepEqual(g.query('P').blockReasons, ['A']);
});

test('undo of a transform append restores prior state exactly', () => {
  const g = assembly();
  const before = g.snapshots[g.snapshots.length - 1];
  g.define('D', 'input');
  g.define('R', 'output');
  g.transform('R', ['Q', 'D']);
  g.hold('D');
  assert.equal(g.query('R').status, 'held');
  g.undo();
  g.undo();
  g.undo();
  g.undo();
  assert.deepEqual(g.snapshots[g.snapshots.length - 1], before);
  assert.throws(() => g.query('R'), /unknown batch/);
});

test('errors: cycle, unknown parent, duplicate output, duplicate define, bad undo', () => {
  const g = new Genealogy();
  g.define('A', 'input');
  g.define('P', 'output');
  g.define('Q', 'output');
  g.transform('P', ['Q']);
  assert.throws(() => g.transform('Q', ['P']), (err) => err.code === 'CYCLE');
  assert.throws(() => g.transform('Q', ['Q']), (err) => err.code === 'CYCLE');
  assert.throws(() => g.transform('Q', ['MISSING']), (err) => err.code === 'UNKNOWN_BATCH');
  assert.throws(() => g.transform('P', ['A']), (err) => err.code === 'DUPLICATE_OUTPUT');
  assert.throws(() => g.define('A'), (err) => err.code === 'DUPLICATE_BATCH');
  assert.throws(() => g.hold('NOPE'), (err) => err.code === 'UNKNOWN_BATCH');
  assert.throws(() => g.correct(99, { op: 'hold', batch: 'A' }), (err) => err.code === 'BAD_INDEX');

  const empty = new Genealogy();
  assert.throws(() => empty.undo(), (err) => err.code === 'NOTHING_TO_UNDO');
  assert.ok(new GenealogyError('X', 'y') instanceof Error);
});

test('failed mutations leave state untouched', () => {
  const g = assembly();
  const before = g.snapshots[g.snapshots.length - 1];
  const version = g.version;
  assert.throws(() => g.transform('Q', ['A']), (err) => err.code === 'DUPLICATE_OUTPUT');
  assert.throws(() => g.correct(0, { op: 'transform', output: 'P', inputs: ['P'] }));
  assert.equal(g.version, version);
  assert.deepEqual(g.snapshots[g.snapshots.length - 1], before);
});

test('random small graphs match independent DFS reference at every step', () => {
  for (let trial = 0; trial < 25; trial += 1) {
    const rand = mulberry32(1000 + trial);
    const g = new Genealogy();
    const journal = [];
    const undoStack = [];
    const defined = [];
    const outputs = new Set();
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];

    const steps = 40;
    for (let step = 0; step < steps; step += 1) {
      const roll = rand();
      try {
        if (roll < 0.25 || defined.length === 0) {
          const id = `B${defined.length}_${trial}`;
          g.define(id, 'input');
          journal.push({ op: 'define', batch: id, kind: 'input' });
          undoStack.push(journal.length - 1);
          defined.push(id);
        } else if (roll < 0.5) {
          const candidates = defined.filter((id) => !outputs.has(id));
          if (candidates.length === 0 || defined.length < 2) continue;
          const output = pick(candidates);
          const outIdx = defined.indexOf(output);
          const possibleInputs = defined.slice(0, outIdx);
          if (possibleInputs.length === 0) continue;
          const inputs = possibleInputs.filter(() => rand() < 0.5);
          if (inputs.length === 0) inputs.push(pick(possibleInputs));
          g.transform(output, inputs);
          journal.push({ op: 'transform', output, inputs: inputs.slice() });
          outputs.add(output);
        } else if (roll < 0.7) {
          const id = pick(defined);
          g.hold(id);
          journal.push({ op: 'hold', batch: id });
        } else if (roll < 0.85) {
          const id = pick(defined);
          g.release(id);
          journal.push({ op: 'release', batch: id });
        } else if (roll < 0.92) {
          const id = pick(defined);
          g.ship(id);
          journal.push({ op: 'ship', batch: id });
        } else if (roll < 0.97) {
          const transformIdx = journal.findIndex((e) => e.op === 'transform');
          if (transformIdx === -1) continue;
          const event = journal[transformIdx];
          const outIdx = defined.indexOf(event.output);
          const possibleInputs = defined.slice(0, outIdx);
          if (possibleInputs.length === 0) continue;
          const inputs = [pick(possibleInputs)];
          g.correct(transformIdx, { op: 'transform', output: event.output, inputs });
          journal[transformIdx] = { op: 'transform', output: event.output, inputs: inputs.slice() };
        } else if (undoStack.length > 0 || journal.length > 0) {
          g.undo();
          journal.pop();
        }
      } catch (err) {
        continue; // invalid random op; library must stay consistent anyway
      }

      const ref = buildReference(journal);
      for (const id of defined) {
        if (!ref.batches.has(id)) continue;
        const cert = g.query(id);
        const refHeld = [...ref.heldAncestorsOf(id)].sort();
        assert.deepEqual(cert.blockReasons, refHeld, `heldAncestors of ${id} @step ${step}`);
        assert.equal(cert.status, ref.statusOf(id), `status of ${id} @step ${step}`);
        const refPaths = [];
        for (const source of refHeld) {
          for (const p of ref.pathsBetween(source, id)) refPaths.push(p);
        }
        const sortPaths = (ps) =>
          ps.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        assert.deepEqual(sortPaths(cert.paths), sortPaths(refPaths), `paths to ${id} @step ${step}`);
      }
    }
  }
});
