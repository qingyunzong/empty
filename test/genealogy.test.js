'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Genealogy } = require('../src/genealogy');

function buildAssembly() {
  const g = new Genealogy();
  g.appendEvent({ id: 'e1', output: 'RAW-A', inputs: [] });
  g.appendEvent({ id: 'e2', output: 'RAW-B', inputs: [] });
  g.appendEvent({ id: 'e3', output: 'SUB-1', inputs: ['RAW-A', 'RAW-B'] });
  g.appendEvent({ id: 'e4', output: 'ASSY-1', inputs: ['SUB-1'] });
  g.appendEvent({ id: 'e5', output: 'FG-1', inputs: ['ASSY-1'] });
  return g;
}

function stripVersion(snapshot) {
  return { ...snapshot, version: 0 };
}

test('multi-level assembly: hold propagates downstream, release clears it', () => {
  const g = buildAssembly();
  const hold = g.hold('RAW-A');

  assert.equal(g.query('SUB-1').status, 'held');
  assert.equal(g.query('ASSY-1').status, 'held');
  assert.equal(g.query('FG-1').status, 'held');
  assert.equal(g.query('RAW-B').status, 'released');

  const changed = hold.diff.statusChanges.map((c) => c.batch);
  assert.deepEqual(changed, ['ASSY-1', 'FG-1', 'RAW-A', 'SUB-1']);
  const fg = hold.diff.statusChanges.find((c) => c.batch === 'FG-1');
  assert.equal(fg.from.status, 'released');
  assert.equal(fg.to.status, 'held');
  assert.deepEqual(fg.to.blockers, ['RAW-A']);

  assert.deepEqual(g.query('FG-1').reasons, [{ source: 'RAW-A', kind: 'ancestor' }]);
  assert.deepEqual(g.query('RAW-A').reasons, [{ source: 'RAW-A', kind: 'self' }]);

  const release = g.release('RAW-A');
  assert.equal(g.query('FG-1').status, 'released');
  const fgBack = release.diff.statusChanges.find((c) => c.batch === 'FG-1');
  assert.equal(fgBack.from.status, 'held');
  assert.equal(fgBack.to.status, 'released');
});

test('certificate lists every path from the quality source to the target', () => {
  const g = new Genealogy();
  g.appendEvent({ id: 'e1', output: 'A', inputs: [] });
  g.appendEvent({ id: 'e2', output: 'B', inputs: ['A'] });
  g.appendEvent({ id: 'e3', output: 'C', inputs: ['A'] });
  g.appendEvent({ id: 'e4', output: 'D', inputs: ['B', 'C'] });
  g.hold('A');

  const cert = g.certificate('D');
  assert.equal(cert.status, 'held');
  assert.deepEqual(cert.riskSources, ['A']);
  assert.deepEqual(cert.paths, [
    ['A', 'B', 'D'],
    ['A', 'C', 'D'],
  ]);
  assert.match(cert.hash, /^[0-9a-f]{64}$/);

  const selfCert = g.certificate('A');
  assert.deepEqual(selfCert.paths, [['A']]);
});

test('shipped batches keep shipped status but certificate lists risk paths', () => {
  const g = buildAssembly();
  g.ship('FG-1');
  g.hold('RAW-A');

  const q = g.query('FG-1');
  assert.equal(q.status, 'shipped');
  assert.deepEqual(q.blockers, ['RAW-A']);
  assert.deepEqual(q.certificate.riskSources, ['RAW-A']);
  assert.deepEqual(q.certificate.paths, [['RAW-A', 'SUB-1', 'ASSY-1', 'FG-1']]);

  assert.equal(g.query('ASSY-1').status, 'held');
  assert.equal(g.query('SUB-1').status, 'held');
});

test('correcting a parent batch yields edge/status diffs; undo restores exactly', () => {
  const g = new Genealogy();
  g.appendEvent({ id: 'e1', output: 'A', inputs: [] });
  g.appendEvent({ id: 'e2', output: 'X', inputs: [] });
  g.hold('A');
  const beforeAppend = g.snapshot();

  g.appendEvent({ id: 'e3', output: 'B', inputs: ['A'] });
  assert.equal(g.query('B').status, 'held');
  const beforeCorrect = g.snapshot();

  const res = g.correctEvent('e3', { inputs: ['X'] });
  assert.deepEqual(res.diff.edges.removed, [['A', 'B']]);
  assert.deepEqual(res.diff.edges.added, [['X', 'B']]);
  assert.equal(g.query('B').status, 'released');
  const change = res.diff.statusChanges.find((c) => c.batch === 'B');
  assert.equal(change.from.status, 'held');
  assert.equal(change.to.status, 'released');

  g.correctEvent('e3', { inputs: ['A'] });
  assert.deepEqual(stripVersion(g.snapshot()), stripVersion(beforeCorrect));

  const undo = g.undoEvent('e3');
  assert.deepEqual(undo.diff.edges.removed, [['A', 'B']]);
  assert.deepEqual(stripVersion(g.snapshot()), stripVersion(beforeAppend));
  assert.throws(() => g.query('B'), (e) => e.code === 'UNKNOWN_BATCH');
});

test('invalid operations raise coded errors and leave state unchanged', () => {
  const g = new Genealogy();
  g.appendEvent({ id: 'e1', output: 'A', inputs: [] });
  g.appendEvent({ id: 'e2', output: 'B', inputs: ['A'] });
  const before = g.snapshot();

  assert.throws(
    () => g.appendEvent({ id: 'e3', output: 'C', inputs: ['NOPE'] }),
    (e) => e.code === 'UNKNOWN_BATCH' && /unknown parent batch: NOPE/.test(e.message),
  );
  assert.throws(
    () => g.appendEvent({ id: 'e4', output: 'A', inputs: [] }),
    (e) => e.code === 'DUPLICATE_OUTPUT',
  );
  assert.throws(
    () => g.appendEvent({ id: 'e1', output: 'Z', inputs: [] }),
    (e) => e.code === 'DUPLICATE_EVENT',
  );
  assert.throws(
    () => g.appendEvent({ id: 'e5', output: 'D', inputs: ['A', 'A'] }),
    (e) => e.code === 'INVALID_EVENT',
  );
  assert.throws(
    () => g.correctEvent('e1', { inputs: ['B'] }),
    (e) => e.code === 'CYCLE',
  );
  assert.throws(
    () => g.correctEvent('e1', { inputs: ['A'] }),
    (e) => e.code === 'CYCLE',
  );
  assert.throws(
    () => g.correctEvent('nope', { inputs: [] }),
    (e) => e.code === 'UNKNOWN_EVENT',
  );
  assert.throws(
    () => g.undoEvent('nope'),
    (e) => e.code === 'UNKNOWN_EVENT',
  );
  assert.throws(
    () => g.undoEvent('e1'),
    (e) => e.code === 'OUTPUT_REFERENCED',
  );
  assert.throws(
    () => g.correctEvent('e1', { output: 'B' }),
    (e) => e.code === 'DUPLICATE_OUTPUT',
  );
  assert.throws(() => g.query('NOPE'), (e) => e.code === 'UNKNOWN_BATCH');
  assert.throws(() => g.hold('NOPE'), (e) => e.code === 'UNKNOWN_BATCH');
  assert.throws(() => g.ship('NOPE'), (e) => e.code === 'UNKNOWN_BATCH');

  assert.deepEqual(g.snapshot(), before);
});

test('renaming an output via correct moves the batch record', () => {
  const g = new Genealogy();
  g.appendEvent({ id: 'e1', output: 'A', inputs: [] });
  g.hold('A');
  const res = g.correctEvent('e1', { output: 'A2' });
  assert.equal(g.query('A2').status, 'held');
  assert.equal(g.query('A2').manualHold, true);
  assert.throws(() => g.query('A'), (e) => e.code === 'UNKNOWN_BATCH');
  const renamed = res.diff.statusChanges.find((c) => c.batch === 'A2');
  assert.equal(renamed.from, null);
  assert.equal(renamed.to.status, 'held');
});

test('same op log yields identical snapshots and certificate hashes', () => {
  const replay = (g) => {
    g.appendEvent({ id: 'e1', output: 'A', inputs: [] });
    g.appendEvent({ id: 'e2', output: 'B', inputs: ['A'] });
    g.appendEvent({ id: 'e3', output: 'C', inputs: ['A'] });
    g.appendEvent({ id: 'e4', output: 'D', inputs: ['B', 'C'] });
    g.hold('A');
    g.ship('D');
    g.correctEvent('e3', { inputs: ['B'] });
    g.release('A');
    g.hold('C');
  };
  const g1 = new Genealogy();
  const g2 = new Genealogy();
  replay(g1);
  replay(g2);
  assert.equal(JSON.stringify(g1.snapshot()), JSON.stringify(g2.snapshot()));
  assert.equal(g1.certificate('D').hash, g2.certificate('D').hash);
  assert.equal(g1.query('D').certificate.hash, g2.query('D').certificate.hash);
});
