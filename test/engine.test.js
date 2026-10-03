import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetEngine, BudgetError } from '../src/engine.js';

// Reference algorithm: full-table sum over settled entries.
function referenceSum(engine, category) {
  let sum = 0;
  for (const entry of engine.entries.values()) {
    if (entry.category === category && entry.status === 'settled') sum += entry.amount;
  }
  return sum;
}

function assertIndexConsistent(engine, category) {
  for (const status of ['settled', 'cancelled']) {
    const viaIndex = engine.indexEntries(category, status).map((e) => e.id).sort();
    const viaScan = [...engine.entries.values()]
      .filter((e) => e.category === category && e.status === status)
      .map((e) => e.id)
      .sort();
    assert.deepEqual(viaIndex, viaScan);
  }
  assert.equal(engine.usedByCategoryIndex(category), referenceSum(engine, category));
}

function* interleavings(a, b) {
  if (a.length === 0) {
    yield [...b];
    return;
  }
  if (b.length === 0) {
    yield [...a];
    return;
  }
  for (const rest of interleavings(a.slice(1), b)) yield [a[0], ...rest];
  for (const rest of interleavings(a, b.slice(1))) yield [b[0], ...rest];
}

test('acceptance 1: budget 100, two 60 settles, exactly one commits in every interleaving', () => {
  const steps = (t) => [[t, 'begin'], [t, 'read'], [t, 'write'], [t, 'commit']];
  let scenarios = 0;
  for (const sequence of interleavings(steps(1), steps(2))) {
    const engine = new BudgetEngine();
    engine.setBudget('food', 100);
    const txns = {};
    let successes = 0;
    for (const [t, op] of sequence) {
      if (op === 'begin') {
        txns[t] = engine.begin();
      } else if (op === 'read') {
        assert.equal(txns[t].available('food') >= 0, true);
      } else if (op === 'write') {
        txns[t].settle('food', 60);
      } else {
        try {
          txns[t].commit();
          successes += 1;
        } catch (err) {
          assert.ok(err instanceof BudgetError, `expected BudgetError, got ${err}`);
          assert.ok(
            ['E_PRED_CONFLICT', 'E_BUDGET'].includes(err.code),
            `unexpected code ${err.code} in ${JSON.stringify(sequence)}`,
          );
        }
      }
    }
    assert.equal(successes, 1, `sequence: ${JSON.stringify(sequence)}`);
    assert.equal(referenceSum(engine, 'food'), 60);
    assertIndexConsistent(engine, 'food');
    scenarios += 1;
  }
  assert.equal(scenarios, 70); // C(8,4) interleavings of two 4-step transactions
});

test('acceptance 2: two 50s reach the cap of 100, the third settle gets E_BUDGET', () => {
  const engine = new BudgetEngine();
  engine.setBudget('food', 100);

  const t1 = engine.begin();
  t1.settle('food', 50);
  t1.commit();
  assert.equal(engine.available('food'), 50);

  const t2 = engine.begin();
  t2.settle('food', 50);
  t2.commit();
  assert.equal(engine.available('food'), 0);
  assert.equal(referenceSum(engine, 'food'), 100);

  const t3 = engine.begin();
  t3.settle('food', 1);
  assert.throws(() => t3.commit(), (err) => err.code === 'E_BUDGET');
  assert.equal(referenceSum(engine, 'food'), 100);
  assertIndexConsistent(engine, 'food');
});

test('acceptance 3: concurrent inserter and canceller, enumerate commit orders, retry matches full-table sum', () => {
  const commitOrders = [
    ['canceller', 'inserter'],
    ['inserter', 'canceller'],
  ];
  for (const order of commitOrders) {
    const engine = new BudgetEngine();
    engine.setBudget('food', 100);
    const setup = engine.begin();
    const originalId = setup.settle('food', 40);
    setup.commit();

    // Both transactions start from the same snapshot (40 settled, 60 available).
    const canceller = engine.begin();
    const inserter = engine.begin();
    canceller.cancel(originalId);
    assert.equal(inserter.available('food'), 60);
    inserter.settle('food', 60);

    const runners = {
      canceller: () => canceller.commit(),
      inserter: () => inserter.commit(),
    };
    const retriers = {
      canceller: () => {
        const retry = engine.begin();
        retry.cancel(originalId);
        retry.commit();
      },
      inserter: () => {
        const retry = engine.begin();
        assert.equal(retry.available('food'), 100);
        retry.settle('food', 60);
        retry.commit();
      },
    };

    for (const who of order) {
      try {
        runners[who]();
      } catch (err) {
        // The loser of the predicate check retries on a fresh snapshot and succeeds.
        assert.equal(err.code, 'E_PRED_CONFLICT', `order ${order}: ${who}`);
        retriers[who]();
      }
    }

    // Result equals the reference full-table sum: original 40 cancelled, new 60 settled.
    assert.equal(referenceSum(engine, 'food'), 60, `order ${order}`);
    assert.equal(engine.getEntry(originalId).status, 'cancelled');
    assertIndexConsistent(engine, 'food');
    assert.equal(engine.available('food'), 40);
  }
});

test('first-committer-wins: two transactions cancelling the same key conflict', () => {
  const engine = new BudgetEngine();
  engine.setBudget('food', 100);
  const setup = engine.begin();
  const id = setup.settle('food', 30);
  setup.commit();

  const t1 = engine.begin();
  const t2 = engine.begin();
  t1.cancel(id);
  t2.cancel(id);
  t1.commit();
  assert.throws(() => t2.commit(), (err) => err.code === 'E_CONFLICT');
  assert.equal(engine.available('food'), 100);
  assertIndexConsistent(engine, 'food');
});

test('snapshot isolation: a transaction does not see later commits', () => {
  const engine = new BudgetEngine();
  engine.setBudget('food', 100);
  const t1 = engine.begin();
  const t2 = engine.begin();
  t2.settle('food', 70);
  t2.commit();
  assert.equal(t1.available('food'), 100); // frozen snapshot
  assert.equal(engine.available('food'), 30); // live view via index
});

test('cancel releases the amount for later settlers', () => {
  const engine = new BudgetEngine();
  engine.setBudget('food', 100);
  const t1 = engine.begin();
  const id = t1.settle('food', 80);
  t1.commit();
  const t2 = engine.begin();
  t2.cancel(id);
  t2.commit();
  assert.equal(engine.available('food'), 100);
  const t3 = engine.begin();
  t3.settle('food', 100);
  t3.commit();
  assert.equal(engine.available('food'), 0);
  assertIndexConsistent(engine, 'food');
});

test('invalid operations raise coded errors', () => {
  const engine = new BudgetEngine();
  engine.setBudget('food', 100);
  const txn = engine.begin();
  assert.throws(() => txn.settle('food', 0), (err) => err.code === 'E_INVALID');
  assert.throws(() => txn.settle('food', -5), (err) => err.code === 'E_INVALID');
  assert.throws(() => txn.settle('nope', 10), (err) => err.code === 'E_NO_BUDGET');
  assert.throws(() => txn.cancel('missing'), (err) => err.code === 'E_NOT_FOUND');
  assert.throws(() => engine.setBudget('bad', -1), (err) => err.code === 'E_INVALID');
});
