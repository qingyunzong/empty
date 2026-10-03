import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertStore } from '../src/store.js';
import { tmpdir, cleanup } from './helpers.js';

test('packet loss produces E_GAP and keeps only the contiguous prefix', async () => {
  const dir = await tmpdir();
  try {
    const store = await AlertStore.open(dir);
    // seq 3 is "lost in transit" and never appended.
    await store.appendBatch([
      { device: 'dev-1', seq: 1, severity: 'info', message: 'm1' },
      { device: 'dev-1', seq: 2, severity: 'info', message: 'm2' },
      { device: 'dev-1', seq: 4, severity: 'info', message: 'm4' },
      { device: 'dev-1', seq: 5, severity: 'info', message: 'm5' },
    ]);

    const res = await store.replay({});
    assert.equal(res.error.code, 'E_GAP');
    assert.deepEqual(res.gaps, [{ device: 'dev-1', expected: 3, found: 4 }]);
    // Contiguous prefix only: the hole is not skipped to fake completeness.
    assert.deepEqual(res.alerts.map((a) => a.seq), [1, 2]);
    assert.deepEqual(res.cursor, { 'dev-1': 2 });

    // Late backfill of seq 3 heals the log; replay from the cursor then
    // delivers 3,4,5 with no gap.
    const r = await store.append({ device: 'dev-1', seq: 3, severity: 'info', message: 'm3' });
    assert.equal(r.status, 'appended');
    const res2 = await store.replay(res.cursor);
    assert.equal(res2.error, undefined);
    assert.deepEqual(res2.alerts.map((a) => a.seq), [3, 4, 5]);
    assert.deepEqual(res2.cursor, { 'dev-1': 5 });
    await store.close();
  } finally {
    await cleanup(dir);
  }
});
