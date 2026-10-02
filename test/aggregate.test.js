import test from 'node:test';
import assert from 'node:assert/strict';
import { Archive } from '../src/archive.js';
import { bruteForceQuery } from '../src/replay.js';
import { toMs } from '../src/time.js';
import { iso, freshDir, readEvents, assertClose } from './helpers.js';

// Acceptance 1: after interleaved corrections, the incrementally maintained
// window aggregate must equal a brute-force replay of the raw event log.
test('interleaved corrections: incremental window mean matches brute-force replay', async () => {
  const dir = await freshDir();
  const a = await Archive.open(dir);

  await a.ingest(
    [
      { site: 'S1', time: iso(0), value: 10, quality: 'good' },
      { site: 'S1', time: iso(1), value: 20, quality: 'good' },
      { site: 'S1', time: iso(2), value: null, quality: 'good' }, // 缺测
      { site: 'S1', time: iso(3), value: 40, quality: 'good' },
      { site: 'S1', time: iso(4), value: 50, quality: 'good' },
      { site: 'S1', time: iso(5), value: 60, quality: 'good' },
    ],
    { batchId: 'load-1' },
  );
  await a.correct({
    batchId: 'fix-1',
    corrections: [
      { site: 'S1', time: iso(1), op: 'replace', value: 26, quality: 'suspect' },
      { site: 'S1', time: iso(3), op: 'flag', quality: 'unknown' },
      { site: 'S1', time: iso(4), op: 'delete' },
    ],
  });
  await a.correct({
    batchId: 'fix-2',
    corrections: [
      { site: 'S1', time: iso(4), op: 'replace', value: 55, quality: 'good' }, // supersedes the delete
      { site: 'S1', time: iso(0), op: 'replace', value: 12, quality: 'good' },
    ],
  });

  const events = await readEvents(dir);
  // check every sub-window, not just the full one
  for (let from = 0; from <= 5; from += 1) {
    for (let to = from; to <= 5; to += 1) {
      const got = a.query('S1', iso(from), iso(to));
      const want = bruteForceQuery(events, 'S1', toMs(iso(from)), toMs(iso(to)));
      assertClose(got.mean, want.mean);
      assert.equal(got.weightSum, want.weightSum, `weightSum [${from},${to}]`);
      assert.equal(got.usedCount, want.usedCount, `usedCount [${from},${to}]`);
      assert.equal(got.nullCount, want.nullCount, `nullCount [${from},${to}]`);
      assert.equal(got.deletedCount, want.deletedCount, `deletedCount [${from},${to}]`);
      assert.equal(got.unknownCount, want.unknownCount, `unknownCount [${from},${to}]`);
      assert.equal(got.confidence, want.confidence, `confidence [${from},${to}]`);
    }
  }

  // full window, hand-computed: visible = 12(g), 26(suspect), null, 40(unknown), 55(g), 60(g)
  const full = a.query('S1', iso(0), iso(5));
  assertClose(full.mean, 160 / 4); // (12 + 26*0.5 + 40*0.5 + 55 + 60) / (1+0.5+0.5+1+1)
  assert.equal(full.nullCount, 1);
  assert.equal(full.usedCount, 5);
  assert.equal(full.confidence, 'unknown'); // one unknown-quality obs: not a failure
});

test('NULL is missing: ignored by the mean but counted', async () => {
  const dir = await freshDir();
  const a = await Archive.open(dir);
  await a.ingest([
    { site: 'S1', time: iso(0), value: 10 },
    { site: 'S1', time: iso(1), value: null },
    { site: 'S1', time: iso(2), value: 30 },
  ]);
  const q = a.query('S1', iso(0), iso(2));
  assertClose(q.mean, 20); // (10+30)/2, NULL excluded
  assert.equal(q.nullCount, 1);
  assert.equal(q.usedCount, 2);

  // replace a value with NULL and back: counts must track both ways
  await a.correct({ batchId: 'c1', corrections: [{ site: 'S1', time: iso(2), op: 'replace', value: null }] });
  const q2 = a.query('S1', iso(0), iso(2));
  assertClose(q2.mean, 10);
  assert.equal(q2.nullCount, 2);
  await a.undo('c1');
  const q3 = a.query('S1', iso(0), iso(2));
  assertClose(q3.mean, 20);
  assert.equal(q3.nullCount, 1);
});

test('unknown quality enters three-valued confidence and is not a failure', async () => {
  const dir = await freshDir();
  const a = await Archive.open(dir);
  await a.ingest([
    { site: 'S1', time: iso(0), value: 10, quality: 'good' },
    { site: 'S1', time: iso(1), value: 20, quality: 'unknown' },
  ]);
  await a.ingest([{ site: 'S2', time: iso(0), value: 10, quality: 'bad' }]);

  const q = a.query('S1', iso(0), iso(1));
  assert.equal(q.confidence, 'unknown'); // three-valued: unknown, NOT low
  assert.notEqual(q.confidence, 'low');
  assertClose(q.mean, (10 + 20 * 0.5) / 1.5); // unknown obs still weighted in

  const bad = a.query('S2', iso(0), iso(0));
  assert.equal(bad.confidence, 'low'); // genuine failure
  assert.equal(bad.mean, null); // bad weight is 0: excluded from the mean
  assert.equal(bad.badCount, 1);
});
