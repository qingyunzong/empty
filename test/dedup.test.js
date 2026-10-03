import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertStore } from '../src/store.js';
import { tmpdir, cleanup } from './helpers.js';

test('duplicate sends are idempotently ignored and counted', async () => {
  const dir = await tmpdir();
  try {
    const store = await AlertStore.open(dir);
    const batch = await store.appendBatch([
      { device: 'dev-1', seq: 1, severity: 'info', message: 'm1' },
      { device: 'dev-1', seq: 2, severity: 'info', message: 'm2' },
      { device: 'dev-1', seq: 2, severity: 'info', message: 'm2-dup' },
      { device: 'dev-1', seq: 3, severity: 'info', message: 'm3' },
      { device: 'dev-1', seq: 3, severity: 'info', message: 'm3-dup' },
      { device: 'dev-1', seq: 1, severity: 'info', message: 'm1-dup' },
    ]);
    assert.deepEqual(batch, { appended: 3, deduped: 3 });

    // Dedup survives a reopen (it is derived from persisted segments).
    await store.close();
    const store2 = await AlertStore.open(dir);
    const r = await store2.append({ device: 'dev-1', seq: 2, severity: 'info', message: 'again' });
    assert.equal(r.status, 'deduped');

    const res = await store2.replay({});
    assert.equal(res.error, undefined);
    assert.deepEqual(res.alerts.map((a) => [a.seq, a.message]), [
      [1, 'm1'],
      [2, 'm2'],
      [3, 'm3'],
    ]);
    await store2.close();
  } finally {
    await cleanup(dir);
  }
});
