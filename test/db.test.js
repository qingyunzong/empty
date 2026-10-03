import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetDB,
  BudgetError,
  E_PRED_CONFLICT,
  E_WRITE_CONFLICT,
  E_BUDGET,
} from '../src/db.js';

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof BudgetError, `expected BudgetError, got ${err}`);
    return err.code;
  }
  return null;
}

// Acceptance 1: budget 100, two concurrent transactions each insert 60.
// Enumerate every interleaving of [settle1, settle2, commit1, commit2]
// (settle before its own commit); exactly one transaction may succeed.
test('budget 100, two concurrent 60 inserts: exactly one commits under any interleaving', () => {
  // All permutations of the four steps with s1<c1 and s2<c2 (6 total).
  const programs = [
    ['s1', 'c1', 's2', 'c2'],
    ['s1', 's2', 'c1', 'c2'],
    ['s1', 's2', 'c2', 'c1'],
    ['s2', 'c2', 's1', 'c1'],
    ['s2', 's1', 'c1', 'c2'],
    ['s2', 's1', 'c2', 'c1'],
  ];
  for (const program of programs) {
    const db = new BudgetDB();
    db.setBudget('ops', 100);
    const tx1 = db.begin();
    const tx2 = db.begin();
    const outcomes = { c1: null, c2: null };
    const run = (step) => {
      switch (step) {
        case 's1': {
          const code = codeOf(() => tx1.settle({ id: 'a', category: 'ops', amount: 60 }));
          assert.ok(code === null || code === E_BUDGET);
          break;
        }
        case 's2': {
          const code = codeOf(() => tx2.settle({ id: 'b', category: 'ops', amount: 60 }));
          assert.ok(code === null || code === E_BUDGET);
          break;
        }
        case 'c1':
          outcomes.c1 = codeOf(() => tx1.commit());
          break;
        case 'c2':
          outcomes.c2 = codeOf(() => tx2.commit());
          break;
      }
    };
    program.forEach(run);

    const successes = [outcomes.c1, outcomes.c2].filter((c) => c === null).length;
    const failures = [outcomes.c1, outcomes.c2].filter((c) => c !== null);
    assert.equal(successes, 1, `program ${program}: exactly one commit must succeed`);
    for (const code of failures) {
      // Loser either saw E_BUDGET at settle time (never staged, commit is a
      // no-op... treat as failed) or hit E_PRED_CONFLICT at commit time.
      assert.ok(
        code === E_PRED_CONFLICT || code === E_BUDGET || code === null,
        `unexpected code ${code}`,
      );
    }
    // At most 60 settled in total; index agrees with the full-table scan.
    assert.equal(db.usedByScan('ops'), 60);
    const tx = db.begin();
    assert.equal(tx.available('ops'), 40);
  }
});

test('loser of the 60/60 race gets E_PRED_CONFLICT when both staged before either commits', () => {
  const db = new BudgetDB();
  db.setBudget('ops', 100);
  const tx1 = db.begin();
  const tx2 = db.begin();
  tx1.settle({ id: 'a', category: 'ops', amount: 60 });
  tx2.settle({ id: 'b', category: 'ops', amount: 60 });
  tx1.commit();
  assert.equal(codeOf(() => tx2.commit()), E_PRED_CONFLICT);
  // Retry with a fresh snapshot now sees the real balance and gets E_BUDGET.
  const tx3 = db.begin();
  assert.equal(codeOf(() => tx3.settle({ id: 'b', category: 'ops', amount: 60 })), E_BUDGET);
});

// Acceptance 2: two 50s at the exact boundary (total 100) succeed one after
// another; a third insert returns E_BUDGET.
test('two 50 inserts totalling exactly 100 succeed sequentially; third gets E_BUDGET', () => {
  const db = new BudgetDB();
  db.setBudget('ops', 100);

  const tx1 = db.begin();
  tx1.settle({ id: 'a', category: 'ops', amount: 50 });
  tx1.commit();

  const tx2 = db.begin();
  tx2.settle({ id: 'b', category: 'ops', amount: 50 });
  tx2.commit();

  const check = db.begin();
  assert.equal(check.available('ops'), 0);
  assert.equal(db.usedByScan('ops'), 100);

  const tx3 = db.begin();
  assert.equal(codeOf(() => tx3.settle({ id: 'c', category: 'ops', amount: 1 })), E_BUDGET);
});

// Acceptance 3: inserter vs canceller concurrency. Budget 100, existing
// settled record of 60; canceller cancels it while inserter adds 40.
// Enumerate commit orders; when the cancel lands first the inserter gets
// E_PRED_CONFLICT and succeeds on retry. Final state must match the
// full-table-sum reference algorithm.
test('concurrent inserter and canceller: enumerate commit orders, retry succeeds, matches scan', () => {
  for (const order of ['cancel-first', 'insert-first']) {
    const db = new BudgetDB();
    db.setBudget('ops', 100);
    const setup = db.begin();
    setup.settle({ id: 'old', category: 'ops', amount: 60 });
    setup.commit();

    const inserter = db.begin();
    const canceller = db.begin();
    inserter.settle({ id: 'new', category: 'ops', amount: 40 });
    canceller.cancel('old');

    if (order === 'cancel-first') {
      canceller.commit();
      assert.equal(codeOf(() => inserter.commit()), E_PRED_CONFLICT);
      // Retry with a fresh snapshot: budget was released, insert succeeds.
      const retry = db.begin();
      retry.settle({ id: 'new', category: 'ops', amount: 40 });
      retry.commit();
    } else {
      inserter.commit();
      // Canceller touched a different key and holds no budget predicate.
      canceller.commit();
    }

    // Reference algorithm: full-table sum of settled records.
    assert.equal(db.usedByScan('ops'), 40, `order=${order}`);
    const tx = db.begin();
    assert.equal(tx.available('ops'), 60, `order=${order}`);
  }
});

test('first-committer-wins on the same key: concurrent cancels conflict', () => {
  const db = new BudgetDB();
  db.setBudget('ops', 100);
  const setup = db.begin();
  setup.settle({ id: 'x', category: 'ops', amount: 10 });
  setup.commit();

  const tx1 = db.begin();
  const tx2 = db.begin();
  tx1.cancel('x');
  tx2.cancel('x');
  tx1.commit();
  assert.equal(codeOf(() => tx2.commit()), E_WRITE_CONFLICT);
  assert.equal(db.usedByScan('ops'), 0);
});

test('snapshot isolation: reader does not see later commits', () => {
  const db = new BudgetDB();
  db.setBudget('ops', 100);
  const reader = db.begin();
  const writer = db.begin();
  writer.settle({ id: 'a', category: 'ops', amount: 30 });
  writer.commit();
  assert.equal(reader.available('ops'), 100);
  assert.equal(db.begin().available('ops'), 70);
});

test('(category,status) secondary index tracks settle and cancel', () => {
  const db = new BudgetDB();
  db.setBudget('ops', 100);
  db.setBudget('misc', 50);
  const tx = db.begin();
  tx.settle({ id: 'a', category: 'ops', amount: 10 });
  tx.settle({ id: 'b', category: 'ops', amount: 20 });
  tx.settle({ id: 'c', category: 'misc', amount: 5 });
  tx.commit();
  const tx2 = db.begin();
  tx2.cancel('a');
  tx2.commit();

  assert.deepEqual(db._indexVisibleIds('ops', 'settled', db.seq).sort(), ['b']);
  assert.deepEqual(db._indexVisibleIds('ops', 'cancelled', db.seq), ['a']);
  assert.deepEqual(db._indexVisibleIds('misc', 'settled', db.seq), ['c']);
  // Index view at the old snapshot still shows the pre-cancel state.
  assert.deepEqual(
    db._indexVisibleIds('ops', 'settled', tx2.snapshotSeq).sort(),
    ['a', 'b'],
  );
});

test('persistence round-trip via toJSON/fromJSON', () => {
  const db = new BudgetDB();
  db.setBudget('ops', 100);
  const tx = db.begin();
  tx.settle({ id: 'a', category: 'ops', amount: 30 });
  tx.commit();
  const tx2 = db.begin();
  tx2.cancel('a');
  tx2.commit();

  const restored = BudgetDB.fromJSON(JSON.parse(JSON.stringify(db.toJSON())));
  assert.equal(restored.getBudget('ops'), 100);
  assert.equal(restored.usedByScan('ops'), 0);
  assert.equal(restored.begin().available('ops'), 100);
});
