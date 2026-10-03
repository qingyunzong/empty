import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Archive } from '../src/archive.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-bnd-'));
}

test('NULL means missing: ignored in mean but counted', () => {
  const archive = new Archive(tmpdir());
  archive.ingest([
    { site: 'S1', validTime: '2026-04-01T00:00:00Z', value: 10, quality: 'good' },
    { site: 'S1', validTime: '2026-04-01T06:00:00Z', value: null, quality: 'good' },
    { site: 'S1', validTime: '2026-04-01T12:00:00Z', value: null, quality: 'unknown' },
  ]);
  const q = archive.query('S1', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z');
  assert.equal(q.weightedMean, 10);
  assert.equal(q.nonNull, 1);
  assert.equal(q.nullCount, 2);
  assert.equal(q.total, 3);
});

test('delete masks but does not physically remove; undo of delete restores', () => {
  const archive = new Archive(tmpdir());
  archive.ingest([{ site: 'S1', validTime: '2026-04-01T00:00:00Z', value: 42, quality: 'good' }]);
  archive.correct({
    batchId: 'DEL1',
    corrections: [{ op: 'delete', site: 'S1', validTime: '2026-04-01T00:00:00Z' }],
  });

  // masked from aggregation
  const q = archive.query('S1', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z');
  assert.equal(q.weightedMean, null);
  assert.equal(q.total, 0);

  // still physically present in the version chain
  const audit = archive.audit('S1|2026-04-01T00:00:00Z');
  assert.equal(audit.tipState, 'deleted');
  assert.equal(audit.chain.length, 2);
  assert.equal(audit.chain[0].value, 42);

  // undoing the delete batch restores the original observation
  archive.undo('DEL1');
  const restored = archive.audit('S1|2026-04-01T00:00:00Z');
  assert.equal(restored.tipState, 'active');
  assert.equal(restored.tip.value, 42);
  const q2 = archive.query('S1', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z');
  assert.equal(q2.weightedMean, 42);
});

test('window boundaries: [from, to) half-open', () => {
  const archive = new Archive(tmpdir());
  archive.ingest([
    { site: 'S1', validTime: '2026-04-01T00:00:00Z', value: 1, quality: 'good' },
    { site: 'S1', validTime: '2026-04-02T00:00:00Z', value: 2, quality: 'good' },
    { site: 'S1', validTime: '2026-04-03T00:00:00Z', value: 3, quality: 'good' },
  ]);
  const q = archive.query('S1', '2026-04-02T00:00:00Z', '2026-04-03T00:00:00Z');
  assert.equal(q.weightedMean, 2);
  assert.equal(q.total, 1);
  const empty = archive.query('S1', '2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z');
  assert.equal(empty.weightedMean, null);
  assert.equal(empty.total, 0);
});

test('unknown quality enters three-valued trust, not failure', () => {
  const archive = new Archive(tmpdir());
  archive.ingest([
    { site: 'S1', validTime: '2026-04-01T00:00:00Z', value: 10, quality: 'good' },
    { site: 'S1', validTime: '2026-04-01T06:00:00Z', value: 20, quality: 'unknown' },
  ]);
  const q = archive.query('S1', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z');
  assert.equal(q.trust, 'unknown');
  // unknown still contributes weight 0.25
  assert.equal(q.weightedMean, (10 * 1.0 + 20 * 0.25) / 1.25);

  archive.ingest([{ site: 'S1', validTime: '2026-04-01T12:00:00Z', value: 5, quality: 'bad' }]);
  const q2 = archive.query('S1', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z');
  assert.equal(q2.trust, 'fail');

  const goodOnly = archive.query('S1', '2026-04-01T00:00:00Z', '2026-04-01T05:00:00Z');
  assert.equal(goodOnly.trust, 'ok');
});

test('flag correction keeps value, attaches flag, may change quality', () => {
  const archive = new Archive(tmpdir());
  archive.ingest([{ site: 'S1', validTime: '2026-04-01T00:00:00Z', value: 10, quality: 'good' }]);
  archive.correct({
    batchId: 'F1',
    corrections: [{ op: 'flag', site: 'S1', validTime: '2026-04-01T00:00:00Z', value: 10, quality: 'suspect', flags: ['spike'] }],
  });
  const audit = archive.audit('S1|2026-04-01T00:00:00Z');
  assert.deepEqual(audit.tip.flags, ['spike']);
  const q = archive.query('S1', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z');
  assert.equal(q.weightedMean, 10);
  assert.equal(q.weightSum, 0.5);
});
