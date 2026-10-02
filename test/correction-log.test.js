'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CorrectionLog, CorrectionError } = require('../src/correction-log');

const OBS = [
  { id: 'temp', value: 20 },
  { id: 'humidity', value: 60 },
];

function makeCorrections(n, observationId = 'temp', base = 20) {
  const corrections = [];
  for (let i = 0; i < n; i += 1) {
    corrections.push({
      id: `c${i + 1}`,
      observationId,
      timestamp: `2024-01-01T00:00:0${i}Z`,
      reason: `REASON_${i + 1}`,
      author: `author${i + 1}`,
      newValue: base + (i + 1) * 10,
    });
  }
  return corrections;
}

function appliedLog(corrections, observations = OBS) {
  const log = new CorrectionLog(observations);
  for (const c of corrections) log.apply(c);
  return log;
}

test('consecutive corrections then undo/redo restores before/after images', () => {
  const log = appliedLog(makeCorrections(3));
  assert.equal(log.getState().temp, 50);

  log.undo();
  assert.equal(log.getState().temp, 40);
  log.undo();
  assert.equal(log.getState().temp, 30);
  assert.equal(log.cursor, 1);
  assert.equal(log.entries[1].status, 'undone');
  assert.equal(log.entries[2].status, 'undone');

  log.redo();
  assert.equal(log.getState().temp, 40);
  log.redo();
  assert.equal(log.getState().temp, 50);
  assert.equal(log.cursor, 3);
  assert.throws(() => log.redo(), (e) => e.code === 'NOTHING_TO_REDO');
});

test('undo only inverts corrections before the cursor', () => {
  const log = appliedLog(makeCorrections(3));
  log.undo();
  log.undo();
  log.redo();
  assert.equal(log.cursor, 2);
  log.undo();
  assert.equal(log.getState().temp, 30);
  assert.equal(log.entries[0].status, 'active');
  assert.equal(log.entries[1].status, 'undone');
});

test('new correction after undo truncates the redo branch', () => {
  const log = appliedLog(makeCorrections(3));
  log.undo();
  log.undo();
  log.apply({
    id: 'c4',
    observationId: 'temp',
    timestamp: '2024-01-01T00:00:03Z',
    reason: 'RECALIBRATION',
    author: 'bob',
    newValue: 99,
  });
  assert.equal(log.entries.length, 2);
  assert.deepEqual(log.entries.map((e) => e.id), ['c1', 'c4']);
  assert.equal(log.getState().temp, 99);
  assert.throws(() => log.redo(), (e) => e.code === 'NOTHING_TO_REDO');
});

test('compression equivalence: final value, audit mapping and state hash preserved', () => {
  const corrections = makeCorrections(4);
  const before = appliedLog(corrections);
  const hashBefore = before.stateHash();
  const stateBefore = before.getState();
  const originalIds = before.entries.map((e) => e.id);

  const after = appliedLog(corrections);
  const merged = after.compress(1, 2);

  assert.deepEqual(after.getState(), stateBefore);
  assert.equal(after.stateHash(), hashBefore);

  assert.equal(merged.before, 30);
  assert.equal(merged.after, 50);
  assert.deepEqual(merged.reasons, ['REASON_2', 'REASON_3']);
  assert.deepEqual(merged.compressedFrom, ['c2', 'c3']);

  const map = after.auditMap();
  const flattened = after.entries.flatMap((e) => e.compressedFrom);
  assert.deepEqual(flattened, originalIds);
  assert.equal(map[merged.id].originalIds.join(','), 'c2,c3');

  const replayed = new CorrectionLog(OBS);
  for (const entry of after.entries) {
    replayed.apply({
      id: entry.id,
      observationId: entry.observationId,
      timestamp: entry.timestamp,
      reason: entry.reason,
      author: entry.author,
      newValue: entry.after,
    });
  }
  assert.deepEqual(replayed.getState(), stateBefore);
  assert.equal(replayed.stateHash(), hashBefore);
});

test('compression folds before/after images only, keeps every reason code', () => {
  const log = appliedLog(makeCorrections(3));
  const merged = log.compress(0, 2);
  assert.equal(log.entries.length, 1);
  assert.equal(merged.before, 20);
  assert.equal(merged.after, 50);
  assert.deepEqual(merged.reasons, ['REASON_1', 'REASON_2', 'REASON_3']);
  assert.equal(log.getState().temp, 50);
});

test('illegal compression ranges are rejected', () => {
  const log = appliedLog(makeCorrections(3));
  assert.throws(() => log.compress(-1, 1), (e) => e.code === 'INVALID_COMPRESS_RANGE');
  assert.throws(() => log.compress(2, 1), (e) => e.code === 'INVALID_COMPRESS_RANGE');
  assert.throws(() => log.compress(1, 3), (e) => e.code === 'INVALID_COMPRESS_RANGE');

  log.undo();
  assert.throws(() => log.compress(1, 2), (e) => e.code === 'COMPRESS_RANGE_CONTAINS_UNDONE');
  assert.throws(() => log.compress(2, 2), (e) => e.code === 'COMPRESS_RANGE_CONTAINS_UNDONE');
  assert.doesNotThrow(() => log.compress(0, 1));
});

test('compression across different observations is rejected', () => {
  const log = new CorrectionLog(OBS);
  log.apply({ id: 'c1', observationId: 'temp', timestamp: 1, reason: 'R', author: 'a', newValue: 21 });
  log.apply({ id: 'c2', observationId: 'humidity', timestamp: 2, reason: 'R', author: 'a', newValue: 61 });
  assert.throws(() => log.compress(0, 1), (e) => e.code === 'COMPRESS_RANGE_MIXED_OBSERVATIONS');
});

test('unknown observation and out-of-order timestamps raise CorrectionError', () => {
  const log = new CorrectionLog(OBS);
  assert.throws(
    () => log.apply({ id: 'x', observationId: 'nope', timestamp: 1, reason: 'R', author: 'a', newValue: 1 }),
    (e) => e instanceof CorrectionError && e.code === 'UNKNOWN_OBSERVATION'
  );
  log.apply({ id: 'c1', observationId: 'temp', timestamp: 10, reason: 'R', author: 'a', newValue: 21 });
  assert.throws(
    () => log.apply({ id: 'c2', observationId: 'temp', timestamp: 9, reason: 'R', author: 'a', newValue: 22 }),
    (e) => e.code === 'OUT_OF_ORDER_TIMESTAMP'
  );
  assert.throws(
    () => log.apply({ id: 'c3', observationId: 'temp', timestamp: 10, reason: 'R', author: 'a', newValue: 22 }),
    (e) => e.code === 'OUT_OF_ORDER_TIMESTAMP'
  );
});

test('exhaustive undo/redo sequences for up to 4 corrections match reference model', () => {
  for (let n = 1; n <= 4; n += 1) {
    const corrections = makeCorrections(n);
    const referenceStateFor = (activeCount) => {
      const ref = new CorrectionLog(OBS);
      for (let i = 0; i < activeCount; i += 1) ref.apply(corrections[i]);
      return ref.getState();
    };

    const sequences = [];
    const enumerate = (prefix, remaining) => {
      sequences.push(prefix);
      if (remaining === 0) return;
      enumerate([...prefix, 'U'], remaining - 1);
      enumerate([...prefix, 'R'], remaining - 1);
    };
    enumerate([], 2 * n);

    for (const seq of sequences) {
      const log = appliedLog(corrections);
      let modelCursor = n;
      for (const op of seq) {
        if (op === 'U') {
          if (modelCursor > 0) { log.undo(); modelCursor -= 1; }
          else assert.throws(() => log.undo(), (e) => e.code === 'NOTHING_TO_UNDO');
        } else if (modelCursor < n) {
          log.redo();
          modelCursor += 1;
        } else {
          assert.throws(() => log.redo(), (e) => e.code === 'NOTHING_TO_REDO');
        }
      }
      assert.deepEqual(
        log.getState(),
        referenceStateFor(modelCursor),
        `n=${n} seq=${seq.join('')} cursor=${modelCursor}`
      );
      assert.equal(log.cursor, modelCursor);
    }
  }
});
