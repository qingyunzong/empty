import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BudgetExhaustedError, IntegerError, TransactionError } from './errors';
import { UndoLogMachine } from './transaction';

test('inner rollback undoes only its own layer', () => {
  const m = new UndoLogMachine();
  m.run(() => {
    m.set('a', 1);
    m.begin();
    m.set('a', 2);
    m.set('b', 5);
    m.rollback();
    assert.equal(m.get('a'), 1);
    assert.equal(m.get('b'), 0);
    assert.deepEqual(m.snapshot(), { a: 1 });
  });
  assert.deepEqual(m.snapshot(), { a: 1 });
});

test('inner commit merges into parent; outer rollback undoes inner writes', () => {
  const m = new UndoLogMachine();
  m.run(() => {
    m.set('a', 1);
    m.begin();
    m.set('a', 2);
    m.commit();
    assert.equal(m.get('a'), 2);
    m.rollback();
    assert.equal(m.get('a'), 0);
  });
  assert.deepEqual(m.snapshot(), {});
});

test('deeply nested savepoints unwind layer by layer', () => {
  const m = new UndoLogMachine();
  m.run(() => {
    m.set('x', 0);
    m.begin();
    m.set('x', 1);
    m.begin();
    m.set('x', 2);
    m.begin();
    m.set('x', 3);
    m.rollback();
    assert.equal(m.get('x'), 2);
    m.commit();
    assert.equal(m.get('x'), 2);
    m.rollback();
    assert.equal(m.get('x'), 0);
  });
  assert.deepEqual(m.snapshot(), { x: 0 });
});

test('capture rolls back its layer and reports the error', () => {
  const m = new UndoLogMachine();
  m.run(() => {
    m.set('a', 1);
    const res = m.capture(() => {
      m.set('a', 99);
      m.set('b', 7);
      throw new Error('boom');
    });
    assert.equal(res.ok, false);
    assert.equal((res.error as Error).message, 'boom');
    assert.equal(m.get('a'), 1);
    assert.equal(m.get('b'), 0);
  });
  assert.deepEqual(m.snapshot(), { a: 1 });
});

test('capture commits its layer when the body succeeds', () => {
  const m = new UndoLogMachine();
  m.run(() => {
    const res = m.capture(() => {
      m.set('a', 10);
      m.add('a', 5);
      m.mul('a', 2);
    });
    assert.equal(res.ok, true);
    assert.equal(m.get('a'), 30);
  });
});

test('capture restores the entry depth even if the body leaks savepoints', () => {
  const m = new UndoLogMachine();
  m.run(() => {
    m.set('a', 1);
    const res = m.capture(() => {
      m.begin();
      m.begin();
      m.set('a', 99);
      m.stage('lost');
      throw new Error('boom');
    });
    assert.equal(res.ok, false);
    assert.equal(m.depth, 1);
    assert.equal(m.get('a'), 1);
    const okRes = m.capture(() => {
      m.begin();
      m.set('b', 2);
    });
    assert.equal(okRes.ok, true);
    assert.equal(m.depth, 1);
    assert.equal(m.get('b'), 2);
  });
  assert.deepEqual(m.snapshot(), { a: 1, b: 2 });
  assert.deepEqual(m.published, []);
});

test('staged actions publish only on the outermost commit', () => {
  const m = new UndoLogMachine();
  m.run(() => {
    m.stage('outer-1');
    m.begin();
    m.stage('inner-discarded');
    m.rollback();
    m.begin();
    m.stage('inner-kept');
    m.commit();
    assert.deepEqual(m.published, []);
    m.stage('outer-2');
  });
  assert.deepEqual(m.published, ['outer-1', 'inner-kept', 'outer-2']);
});

test('actions staged in a failed capture are discarded', () => {
  const m = new UndoLogMachine();
  m.run(() => {
    m.stage('kept');
    m.capture(() => {
      m.stage('lost');
      throw new Error('boom');
    });
  });
  assert.deepEqual(m.published, ['kept']);
});

test('budget exhaustion aborts the run and rolls back everything', () => {
  const m = new UndoLogMachine();
  assert.throws(
    () =>
      m.run(() => {
        m.set('a', 1);
        m.stage('never-published');
        m.set('b', 2);
        m.set('c', 3);
      }, { budget: 3 }),
    BudgetExhaustedError,
  );
  assert.deepEqual(m.snapshot(), {});
  assert.deepEqual(m.published, []);
  assert.equal(m.depth, 0);
  assert.equal(m.budgetLeft, 0);
});

test('budget exhaustion propagates through capture', () => {
  const m = new UndoLogMachine();
  assert.throws(
    () =>
      m.run(() => {
        m.set('a', 1);
        m.capture(() => {
          m.set('b', 2);
          m.set('c', 3);
        });
      }, { budget: 2 }),
    BudgetExhaustedError,
  );
  assert.deepEqual(m.snapshot(), {});
  assert.deepEqual(m.published, []);
});

test('operations without an open transaction fail', () => {
  const m = new UndoLogMachine();
  assert.throws(() => m.commit(), TransactionError);
  assert.throws(() => m.rollback(), TransactionError);
  assert.throws(() => m.set('a', 1), TransactionError);
  assert.throws(() => m.stage('x'), TransactionError);
});

test('non-integer values and overflowing results are rejected', () => {
  const m = new UndoLogMachine();
  m.run(() => {
    assert.throws(() => m.set('a', 1.5), IntegerError);
    assert.throws(() => m.add('a', Number.NaN), IntegerError);
    assert.throws(() => m.mul('a', 0.5), IntegerError);
    m.set('big', Number.MAX_SAFE_INTEGER);
    assert.throws(() => m.add('big', 1), IntegerError);
    assert.throws(() => m.mul('big', 2), IntegerError);
    assert.equal(m.get('big'), Number.MAX_SAFE_INTEGER);
  });
});

test('run auto-commits frames left open by the body', () => {
  const m = new UndoLogMachine();
  m.run(() => {
    m.set('a', 1);
    m.begin();
    m.set('b', 2);
    m.stage('left-open');
  });
  assert.deepEqual(m.snapshot(), { a: 1, b: 2 });
  assert.deepEqual(m.published, ['left-open']);
});

test('mid-run root commit publishes; a later abort cannot unpublish it', () => {
  const m = new UndoLogMachine();
  assert.throws(
    () =>
      m.run(() => {
        m.stage('first');
        m.commit();
        assert.deepEqual(m.published, ['first']);
        m.begin();
        m.set('a', 5);
        m.stage('second');
        throw new Error('late failure');
      }),
    (e: unknown) => e instanceof Error && e.message === 'late failure',
  );
  assert.deepEqual(m.published, ['first']);
  assert.deepEqual(m.snapshot(), {});
});

test('run cannot be nested and drainPublished empties the log', () => {
  const m = new UndoLogMachine();
  m.run(() => {
    assert.throws(() => m.run(() => undefined), TransactionError);
    m.stage('x');
  });
  assert.deepEqual(m.drainPublished(), ['x']);
  assert.deepEqual(m.published, []);
});
