import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { referenceWindows } from '../src/reference.js';
import { WINDOW_SECONDS } from '../src/windows.js';
import { tmpdir, stripVersion } from '../test-support/helpers.js';

// Scenario 2: every window before the first event is unknown.
test('scenario2: all windows before the first event are unknown', () => {
  const dir = tmpdir('scenario2-');
  const store = Store.open(dir);

  // No events at all: everything is unknown.
  const empty = store.query('d1', 0, 2700);
  assert.equal(empty.length, 3);
  for (const row of empty) {
    assert.equal(row.uptime, null);
    assert.equal(row.downtime, null);
    assert.equal(row.unknown, WINDOW_SECONDS);
  }

  const events = [{ id: 'e1', device: 'd1', ts: 50000, state: 'up' }];
  store.appendBatch(events);

  const rows = store.query('d1', 0, 49500);
  assert.equal(rows.length, 55);
  for (const row of rows) {
    assert.equal(row.uptime, null, `window ${row.windowStart} uptime null`);
    assert.equal(row.downtime, null, `window ${row.windowStart} downtime null`);
    assert.equal(row.unknown, WINDOW_SECONDS, `window ${row.windowStart} fully unknown`);
  }

  // The window containing the first event is partially unknown.
  const boundary = store.query('d1', 49500, 50400)[0];
  assert.deepEqual(
    { up: boundary.uptime, down: boundary.downtime, unknown: boundary.unknown },
    { up: 400, down: 0, unknown: 500 },
  );

  // Matches the per-second reference exactly.
  const reference = referenceWindows(events, 'd1', 0, 50400);
  assert.deepEqual(store.query('d1', 0, 50400).map(stripVersion), reference);
});
