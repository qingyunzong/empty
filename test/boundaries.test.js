import test from 'node:test';
import assert from 'node:assert/strict';
import { Archive } from '../src/archive.js';
import { iso, freshDir } from './helpers.js';

// Acceptance 3: missing-data / deletion edge behaviour.
test('all-NULL window: mean is null, missing count preserved', async () => {
  const dir = await freshDir();
  const a = await Archive.open(dir);
  await a.ingest([
    { site: 'S1', time: iso(0), value: null },
    { site: 'S1', time: iso(1), value: null },
  ]);
  const q = a.query('S1', iso(0), iso(1));
  assert.equal(q.mean, null);
  assert.equal(q.nullCount, 2);
  assert.equal(q.usedCount, 0);
  assert.equal(q.confidence, 'unknown'); // no usable data: honest unknown
});

test('delete masks without physical removal; undo restores', async () => {
  const dir = await freshDir();
  const a = await Archive.open(dir);
  await a.ingest([
    { site: 'S1', time: iso(0), value: 10 },
    { site: 'S1', time: iso(1), value: 20 },
  ]);
  await a.correct({
    batchId: 'del',
    corrections: [
      { site: 'S1', time: iso(0), op: 'delete' },
      { site: 'S1', time: iso(1), op: 'delete' },
    ],
  });
  const q = a.query('S1', iso(0), iso(1));
  assert.equal(q.mean, null);
  assert.equal(q.deletedCount, 2);
  assert.equal(q.usedCount, 0);

  // history is still there: delete only masked it
  const audit = a.audit(`S1@${iso(0)}`);
  assert.equal(audit.history.length, 2);
  assert.deepEqual(audit.current, { deleted: true });

  await a.undo('del');
  const q2 = a.query('S1', iso(0), iso(1));
  assert.equal(q2.mean, 15);
  assert.equal(q2.deletedCount, 0);
});

test('window edges are inclusive; empty window is all zeros', async () => {
  const dir = await freshDir();
  const a = await Archive.open(dir);
  await a.ingest([
    { site: 'S1', time: iso(1), value: 100 },
    { site: 'S1', time: iso(2), value: 200 },
  ]);
  const edge = a.query('S1', iso(1), iso(1));
  assert.equal(edge.mean, 100);
  assert.equal(edge.usedCount, 1);

  const empty = a.query('S1', iso(10), iso(20));
  assert.equal(empty.mean, null);
  assert.equal(empty.usedCount, 0);
  assert.equal(empty.nullCount, 0);
  assert.equal(empty.deletedCount, 0);

  const noSite = a.query('NOPE', iso(0), iso(5));
  assert.equal(noSite.mean, null);
  assert.equal(noSite.usedCount, 0);

  assert.throws(() => a.query('S1', iso(2), iso(1)), /from must be <= to/);
});
