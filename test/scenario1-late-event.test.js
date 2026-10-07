import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { referenceWindows } from '../src/reference.js';
import { WINDOW_SECONDS } from '../src/windows.js';
import { tmpdir, stripVersion } from '../test-support/helpers.js';

// Scenario 1: a late down event splits an up window and corrects multiple buckets.
test('scenario1: late down event splits up window and corrects multiple buckets', () => {
  const dir = tmpdir('scenario1-');
  const store = Store.open(dir);

  const batch1 = [
    { id: 'e1', device: 'd1', ts: 10000, state: 'up' },
    { id: 'e2', device: 'd1', ts: 20000, state: 'up' },
  ];
  store.appendBatch(batch1);

  const before = store.query('d1', 9900, 21600);
  for (const row of before) {
    const up = row.uptime ?? 0;
    const down = row.downtime ?? 0;
    assert.equal(up + down + row.unknown, WINDOW_SECONDS, 'window parts sum to 900');
  }
  const w10800Before = before.find((r) => r.windowStart === 10800);
  assert.deepEqual(
    { up: w10800Before.uptime, down: w10800Before.downtime, unknown: w10800Before.unknown },
    { up: 900, down: 0, unknown: 0 },
    'window 10800 fully up before the late event',
  );

  // Late event: ts 11000 is behind the watermark (20000).
  const batch2 = [{ id: 'e3', device: 'd1', ts: 11000, state: 'down' }];
  store.appendBatch(batch2);

  const all = [...batch1, ...batch2];
  const reference = referenceWindows(all, 'd1', 9900, 21600);
  const after = store.query('d1', 9900, 21600);
  assert.deepEqual(after.map(stripVersion), reference, 'matches per-second reference');

  // The up window is split: up 10000..11000, down 11000..20000, up from 20000.
  const w10800 = after.find((r) => r.windowStart === 10800);
  assert.equal(w10800.uptime, 200, '10800..11000 still up');
  assert.equal(w10800.downtime, 700, '11000..11700 now down');

  // Multiple buckets were retracted and republished with bumped versions.
  const retracts = store.aggregator.corrections.filter((c) => c.type === 'retract');
  const correctedWindows = new Set(retracts.map((c) => c.windowStart));
  assert.ok(correctedWindows.size >= 2, `multiple buckets corrected: ${[...correctedWindows]}`);
  for (const w of correctedWindows) {
    const row = after.find((r) => r.windowStart === w);
    assert.equal(row.version, 2, `window ${w} republished at version 2`);
  }

  // No double counting: exactly one live version per (device, window) and the
  // live versions alone reproduce the reference totals.
  const liveKeys = new Set(after.map((r) => `${r.device}|${r.windowStart}`));
  assert.equal(liveKeys.size, after.length);
  const totalUp = after.reduce((n, r) => n + (r.uptime ?? 0), 0);
  const totalDown = after.reduce((n, r) => n + (r.downtime ?? 0), 0);
  assert.equal(totalUp, reference.reduce((n, r) => n + (r.uptime ?? 0), 0));
  assert.equal(totalDown, reference.reduce((n, r) => n + (r.downtime ?? 0), 0));

  // Corrections survive a restart (log replay yields identical results).
  const reopened = Store.open(dir);
  assert.deepEqual(reopened.query('d1', 9900, 21600).map(stripVersion), reference);
});
