import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertStore, compareAlerts } from '../src/store.js';
import { tmpdir, cleanup } from './helpers.js';

test('manual fold of a small sequence set matches replay output', async () => {
  const dir = await tmpdir();
  try {
    const input = [
      { device: 'dev-b', seq: 2, severity: 'warning', message: 'b2' },
      { device: 'dev-a', seq: 1, severity: 'critical', message: 'a1' },
      { device: 'dev-b', seq: 1, severity: 'info', message: 'b1' },
      { device: 'dev-a', seq: 3, severity: 'info', message: 'a3' },
      { device: 'dev-a', seq: 2, severity: 'critical', message: 'a2' },
      { device: 'dev-b', seq: 3, severity: 'critical', message: 'b3' },
    ];
    // Manual fold: severity rank first, ties broken by device id then seq.
    const expected = [...input].sort(compareAlerts);

    const store = await AlertStore.open(dir);
    const batch = await store.appendBatch(input);
    assert.deepEqual(batch, { appended: 6, deduped: 0 });
    const res = await store.replay({});
    await store.close();

    assert.equal(res.error, undefined);
    assert.deepEqual(res.alerts, expected);
    assert.deepEqual(res.cursor, { 'dev-a': 3, 'dev-b': 3 });

    // Incremental replay with the returned cursor yields nothing new.
    const again = await (await AlertStore.open(dir)).replay(res.cursor);
    assert.deepEqual(again.alerts, []);
    assert.deepEqual(again.cursor, res.cursor);
  } finally {
    await cleanup(dir);
  }
});
