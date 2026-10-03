import test from 'node:test';
import assert from 'node:assert/strict';
import { Interpreter } from '../src/interp.js';
import { Model } from '../src/model.js';

const PRELUDE = `
  line L1, L2;
  calendar main { shift mon..fri 08:00-16:00; }
  job J0 { line: L1; duration: 1h; priority: 1; }
`;

function fresh() {
  const interp = new Interpreter(new Model());
  interp.runSource(PRELUDE);
  return interp;
}

test('nested savepoints: rollback removes later savepoints, keeps earlier ones (acceptance 2)', () => {
  const interp = fresh();
  interp.runSource(`
    add-job A { line: L1; duration: 1h; priority: 1; };
    savepoint s1;
    add-job B { line: L1; duration: 1h; priority: 1; };
    savepoint s2;
    add-job C { line: L2; duration: 1h; priority: 1; };
    move-job A to L2;
  `);
  assert.deepEqual([...interp.model.jobs.keys()], ['J0', 'A', 'B', 'C']);
  assert.equal(interp.model.jobs.get('A').line, 'L2');
  interp.runSource('rollback s1;');
  // State at and after s1 is undone: B and C are gone, A is back on L1.
  assert.deepEqual([...interp.model.jobs.keys()], ['J0', 'A']);
  assert.equal(interp.model.jobs.get('A').line, 'L1');
  // s2 was created after s1 and is removed.
  assert.throws(() => interp.runSource('rollback s2;'), /no such savepoint/);
  // s1 itself is still valid and can be rolled back to again.
  interp.runSource(`
    add-job D { line: L1; duration: 1h; priority: 1; };
    rollback s1;
  `);
  assert.deepEqual([...interp.model.jobs.keys()], ['J0', 'A']);
  interp.runSource('commit;');
  assert.equal(interp.committed, true);
});

test('earlier savepoints survive a rollback to a later one', () => {
  const interp = fresh();
  interp.runSource(`
    savepoint s0;
    add-job A { line: L1; duration: 1h; priority: 1; };
    savepoint s1;
    add-job B { line: L1; duration: 1h; priority: 1; };
    rollback s1;
  `);
  assert.deepEqual([...interp.model.jobs.keys()], ['J0', 'A']);
  interp.runSource('rollback s0;');
  assert.deepEqual([...interp.model.jobs.keys()], ['J0']);
});

test('rollback without a name targets the most recent savepoint', () => {
  const interp = fresh();
  interp.runSource(`
    add-job A { line: L1; duration: 1h; priority: 1; };
    savepoint sp;
    add-job B { line: L1; duration: 1h; priority: 1; };
    rollback;
  `);
  assert.deepEqual([...interp.model.jobs.keys()], ['J0', 'A']);
});

test('rollback to an unknown savepoint fails', () => {
  const interp = fresh();
  assert.throws(() => interp.runSource('rollback nope;'), /no such savepoint/);
});

test('commit finalizes all active transaction state', () => {
  const interp = fresh();
  interp.runSource(`
    add-job A { line: L1; duration: 1h; priority: 1; };
    savepoint s1;
    add-job B { line: L2; duration: 2h; priority: 2; };
    commit;
  `);
  assert.deepEqual([...interp.model.jobs.keys()], ['J0', 'A', 'B']);
  assert.equal(interp.txn.log.length, 0);
  assert.equal(interp.txn.savepoints.length, 0);
  // Savepoints from before the commit no longer exist.
  assert.throws(() => interp.runSource('rollback s1;'), /no such savepoint/);
});
