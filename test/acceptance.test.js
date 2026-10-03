'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../src/db');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pallet-acc-'));
}

function seed(db, entries) {
  const t = db.begin();
  for (const [pallet, lot, q] of entries) t.put(pallet, lot, q);
  t.commit();
}

test('acceptance 1a: crash at after_records rolls back all tentative transfers', () => {
  const dir = tmpdir();
  let db = Database.open(dir);
  seed(db, [['P1', 'L1', false], ['P1', 'L2', false], ['P1', 'L3', true], ['P2', 'X1', true]]);
  const beforeState = db.dump();
  const beforeIndex = db.dumpIndex();

  db = Database.open(dir, { crashAt: 'after_records' });
  const t = db.begin();
  t.transfer('P1', 'P2', ['L1', 'L2', 'L3'], true);
  assert.throws(() => t.commit(), (e) => e.code === 'E_CRASH' && e.point === 'after_records');

  db = Database.open(dir);
  assert.deepEqual(db.dump(), beforeState, 'source/target state unchanged after recovery');
  assert.deepEqual(db.dumpIndex(), beforeIndex, 'index rebuilt to pre-transfer state');
  assert.equal(db.read('P1', 'L1').quarantine, false);
  assert.equal(db.read('P1', 'L3').quarantine, true, 'quarantine flags preserved');
  assert.equal(db.read('P2', 'L1'), null);
});

test('acceptance 1b: crash at after_commit makes all transfers visible', () => {
  const dir = tmpdir();
  let db = Database.open(dir);
  seed(db, [['P1', 'L1', false], ['P1', 'L2', false], ['P1', 'L3', false], ['P2', 'X1', true]]);

  db = Database.open(dir, { crashAt: 'after_commit' });
  const t = db.begin();
  t.transfer('P1', 'P2', ['L1', 'L2', 'L3'], true);
  assert.throws(() => t.commit(), (e) => e.code === 'E_CRASH' && e.point === 'after_commit');

  db = Database.open(dir);
  assert.deepEqual(db.dump(), {
    pallets: {
      P2: {
        X1: { quarantine: true },
        L1: { quarantine: true },
        L2: { quarantine: true },
        L3: { quarantine: true },
      },
    },
  });
  assert.equal(db.dumpIndex().length, 4);
  assert.equal(db.read('P1', 'L1'), null);
});

test('acceptance 2: concurrent transfer of same batch -> one E_SNAPSHOT; dup lot on target -> E_DUP', () => {
  const dir = tmpdir();
  const db = Database.open(dir);
  seed(db, [['P1', 'L1', false], ['P2', 'L1', true]]); // same lotId on two pallets is allowed

  // Two transactions move the same batch (P1,L1) to different targets.
  const t1 = db.begin();
  const t2 = db.begin();
  t1.move('P1', 'P3', 'L1');
  t2.move('P1', 'P4', 'L1');
  t1.commit();
  assert.throws(() => t2.commit(), (e) => e.code === 'E_SNAPSHOT');
  assert.equal(db.read('P3', 'L1').quarantine, false);
  assert.equal(db.read('P4', 'L1'), null);

  // Target pallet already holds lotId L1 -> E_DUP.
  const t3 = db.begin();
  t3.move('P3', 'P2', 'L1');
  assert.throws(() => t3.commit(), (e) => e.code === 'E_DUP');
  assert.equal(db.read('P3', 'L1').quarantine, false, 'failed txn left no trace');
  assert.equal(db.read('P2', 'L1').quarantine, true);
});

test('snapshot isolation: a transaction reads a stable snapshot', () => {
  const dir = tmpdir();
  const db = Database.open(dir);
  seed(db, [['P1', 'L1', false]]);

  const t1 = db.begin();
  const t2 = db.begin();
  t2.move('P1', 'P2', 'L1', true);
  t2.commit();

  assert.deepEqual(t1.read('P1', 'L1'), { pallet: 'P1', lot: 'L1', quarantine: false });
  assert.equal(t1.read('P2', 'L1'), null);
  assert.deepEqual(db.read('P2', 'L1'), { pallet: 'P2', lot: 'L1', quarantine: true });

  // MVCC version chain keeps both committed versions of the key.
  const chain = db.versions.get('P1\0L1');
  assert.equal(chain.length, 1);
  assert.equal(chain[0].cmax, 2);
  const chain2 = db.versions.get('P2\0L1');
  assert.equal(chain2.length, 1);
  assert.equal(chain2[0].cmin, 2);
});

// Acceptance 3: exhaustive transfer/crash histories checked against a naive
// reference that only applies fully committed blocks.
test('acceptance 3: enumerated histories match naive committed-only replay', () => {
  const LOTS = ['a', 'b', 'c'];
  const PALLETS = ['P1', 'P2'];
  const CRASHES = ['none', 'after_records', 'after_commit'];
  const dir = tmpdir();

  const normalize = (ref) => {
    const pallets = {};
    for (const p of [...PALLETS].sort()) {
      const lots = Object.keys(ref[p]).sort();
      if (lots.length === 0) continue;
      pallets[p] = {};
      for (const l of lots) pallets[p][l] = { quarantine: ref[p][l] };
    }
    return { pallets };
  };

  const findPallet = (ref, lot) => PALLETS.find((p) => lot in ref[p]);

  const refMove = (ref, lot, q) => {
    const src = findPallet(ref, lot);
    const dst = src === 'P1' ? 'P2' : 'P1';
    delete ref[src][lot];
    ref[dst][lot] = q;
  };

  let histories = 0;
  const run = (history) => {
    histories++;
    fs.rmSync(dir, { recursive: true, force: true });
    const ref = { P1: { a: false, b: false, c: false }, P2: {} };
    let db = Database.open(dir);
    seed(db, [['P1', 'a', false], ['P1', 'b', false], ['P1', 'c', false]]);

    for (const step of history) {
      const src = findPallet(ref, step.lot);
      const dst = src === 'P1' ? 'P2' : 'P1';
      if (step.crash === 'none') {
        const t = db.begin();
        t.transfer(src, dst, [step.lot], step.q);
        t.commit();
        refMove(ref, step.lot, step.q);
      } else {
        const crashing = Database.open(dir, { crashAt: step.crash });
        const t = crashing.begin();
        t.transfer(src, dst, [step.lot], step.q);
        assert.throws(() => t.commit(), (e) => e.code === 'E_CRASH' && e.point === step.crash);
        if (step.crash === 'after_commit') refMove(ref, step.lot, step.q);
        db = Database.open(dir);
        assert.deepEqual(
          db.dump(),
          normalize(ref),
          `state after recovery from ${step.crash} in ${JSON.stringify(history)}`,
        );
      }
    }
    // Final clean restart: state and rebuilt index must match the reference.
    db = Database.open(dir);
    assert.deepEqual(db.dump(), normalize(ref), `final state for ${JSON.stringify(history)}`);
    const expectedIndex = [];
    for (const p of [...PALLETS].sort()) {
      for (const l of Object.keys(ref[p]).sort()) expectedIndex.push({ pallet: p, lot: l, quarantine: ref[p][l] });
    }
    assert.deepEqual(db.dumpIndex(), expectedIndex, `rebuilt index for ${JSON.stringify(history)}`);
  };

  const steps = [];
  for (const lot of LOTS) {
    for (const q of [false, true]) {
      for (const crash of CRASHES) steps.push({ lot, q, crash });
    }
  }
  for (const s1 of steps) {
    run([s1]);
    for (const s2 of steps) {
      run([s1, s2]);
      for (const s3 of steps) run([s1, s2, s3]);
    }
  }
  assert.equal(histories, 18 + 18 * 18 + 18 * 18 * 18);
});
