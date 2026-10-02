import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const t = (s) => Date.parse(s);
const ev = (id, equipment, valid_time, state, tx_id, tx_time) => ({
  id,
  equipment,
  valid_time,
  state,
  tx_id,
  tx_time,
});
const batch = (tx_id, tx_time, events) => ({ kind: 'batch', tx_id, tx_time, events });

test('retroactive correction changes current view but not historical AS OF', () => {
  const engine = new Engine();
  engine.applyBatch(
    batch('tx1', '2024-03-10T01:00:00Z', [
      ev('e1', 'pump-7', '2024-03-10T00:00:00Z', 'up', 'tx1', '2024-03-10T01:00:00Z'),
    ]),
  );
  const historicalBefore = engine.asOf('pump-7', t('2024-03-10T00:00:00Z'), t('2024-03-10T02:00:00Z'));
  assert.equal(historicalBefore, 'up');

  const deltas = engine.applyBatch(
    batch('tx2', '2024-03-15T09:00:00Z', [
      ev('e2', 'pump-7', '2024-03-10T00:00:00Z', 'down', 'tx2', '2024-03-15T09:00:00Z'),
    ]),
  );
  assert.deepEqual(deltas, [{ equipment: 'pump-7', date: '2024-03-10', up: -1, down: 1 }]);

  // Current view reflects the correction...
  assert.equal(engine.asOf('pump-7', t('2024-03-10T00:00:00Z')), 'down');
  // ...but the view as of the old transaction time is untouched.
  assert.equal(engine.asOf('pump-7', t('2024-03-10T00:00:00Z'), t('2024-03-10T02:00:00Z')), 'up');
  assert.deepEqual(engine.countsSnapshot(), {
    'pump-7': { '2024-03-10': { up: 0, down: 1 } },
  });
});

test('out-of-order tx_time: visibility follows transaction time, not arrival', () => {
  const engine = new Engine();
  engine.applyBatch(
    batch('txA', '2024-05-10T00:00:00Z', [
      ev('e1', 'valve-3', '2024-05-01T00:00:00Z', 'up', 'txA', '2024-05-10T00:00:00Z'),
    ]),
  );
  // Arrives second but carries an *earlier* tx_time: it must not override.
  const deltas = engine.applyBatch(
    batch('txB', '2024-05-05T00:00:00Z', [
      ev('e2', 'valve-3', '2024-05-01T00:00:00Z', 'down', 'txB', '2024-05-05T00:00:00Z'),
    ]),
  );
  assert.deepEqual(deltas, []); // current view unchanged -> no count delta
  assert.equal(engine.asOf('valve-3', t('2024-05-01T00:00:00Z')), 'up');
  // Between the two tx_times only the late-arriving event is visible.
  assert.equal(engine.asOf('valve-3', t('2024-05-01T00:00:00Z'), t('2024-05-07T00:00:00Z')), 'down');
  assert.equal(engine.asOf('valve-3', t('2024-05-01T00:00:00Z'), t('2024-05-04T00:00:00Z')), null);
});

test('undo maintains snapshot and deltas', () => {
  const engine = new Engine();
  engine.applyBatch(
    batch('tx1', '2024-06-01T00:00:00Z', [
      ev('e1', 'eq', '2024-06-01T00:00:00Z', 'up', 'tx1', '2024-06-01T00:00:00Z'),
    ]),
  );
  engine.applyBatch(
    batch('tx2', '2024-06-02T00:00:00Z', [
      ev('e2', 'eq', '2024-06-02T00:00:00Z', 'down', 'tx2', '2024-06-02T00:00:00Z'),
    ]),
  );
  const deltas = engine.undo('tx1');
  assert.deepEqual(deltas, [{ equipment: 'eq', date: '2024-06-01', up: -1, down: 0 }]);
  assert.deepEqual(engine.countsSnapshot(), {
    eq: { '2024-06-02': { up: 0, down: 1 } },
  });
  assert.equal(engine.asOf('eq', t('2024-06-01T00:00:00Z')), null);
  assert.equal(engine.asOf('eq', t('2024-06-02T00:00:00Z')), 'down');
  assert.throws(() => engine.undo('tx1'), /already undone/);
  assert.throws(() => engine.undo('nope'), /unknown tx_id/);
});

test('undo in the middle of a supersession chain rebuilds correctly', () => {
  const engine = new Engine();
  const at = (n) => `2024-01-0${n}T00:00:00Z`;
  engine.applyBatch(batch('tx1', at(1), [ev('e1', 'eq', at(1), 'up', 'tx1', at(1))]));
  engine.applyBatch(batch('tx2', at(2), [ev('e2', 'eq', at(1), 'down', 'tx2', at(2))]));
  engine.applyBatch(batch('tx3', at(3), [ev('e3', 'eq', at(1), 'up', 'tx3', at(3))]));
  assert.deepEqual(engine.countsSnapshot(), { eq: { '2024-01-01': { up: 1, down: 0 } } });

  // Removing the middle link must not resurrect it; tx3 still wins.
  const deltas = engine.undo('tx2');
  assert.deepEqual(deltas, []);
  assert.equal(engine.asOf('eq', t(at(1))), 'up');

  // Removing tx3 exposes tx1 again (tx2 is gone).
  const deltas2 = engine.undo('tx3');
  assert.deepEqual(deltas2, []); // up stays 1: tx1 becomes effective again
  assert.equal(engine.asOf('eq', t(at(1))), 'up');
  assert.deepEqual(engine.countsSnapshot(), { eq: { '2024-01-01': { up: 1, down: 0 } } });
});

test('deltas aggregate multiple equipments and days within one batch', () => {
  const engine = new Engine();
  const deltas = engine.applyBatch(
    batch('tx1', '2024-07-10T00:00:00Z', [
      ev('e1', 'a', '2024-07-01T00:00:00Z', 'up', 'tx1', '2024-07-10T00:00:00Z'),
      ev('e2', 'a', '2024-07-02T00:00:00Z', 'down', 'tx1', '2024-07-10T00:00:00Z'),
      ev('e3', 'b', '2024-07-01T00:00:00Z', 'down', 'tx1', '2024-07-10T00:00:00Z'),
    ]),
  );
  assert.deepEqual(deltas, [
    { equipment: 'a', date: '2024-07-01', up: 1, down: 0 },
    { equipment: 'a', date: '2024-07-02', up: 0, down: 1 },
    { equipment: 'b', date: '2024-07-01', up: 0, down: 1 },
  ]);
});
