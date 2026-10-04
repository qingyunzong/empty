import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, FAILPOINTS } from '../src/store.js';
import { ingestEvents, recoverAndFinalize } from '../src/engine.js';
import { tmpdir, ev } from './helpers.mjs';

function batch() {
  return [
    ev({ id: 's1', ts: 1, kind: 'quality.scan', payload: { result: 'pass', qty: 4 } }),
    ev({ id: 'h1', ts: 2, kind: 'quality.hold', payload: {} }),
    ev({ id: 'r1', ts: 3, kind: 'quality.release', payload: {} }),
    ev({ id: 's2', ts: 4, kind: 'quality.scan', payload: { result: 'pass', qty: 6 } }),
    ev({ id: 'a1', ts: 5, kind: 'device.alarm', payload: {} }),
    ev({ id: 'c1', ts: 6, kind: 'device.clear', payload: {} }),
  ];
}

function cleanRun() {
  const store = new Store(tmpdir());
  ingestEvents(store, batch());
  return store.state;
}

// Crash at every persistence fault point (before/after event log append,
// before/after index update, before/after state commit), then recover.
// The recovered state must equal the clean run: every event applied exactly once.
for (const fp of FAILPOINTS) {
  test(`crash at ${fp}: recovery applies every event exactly once`, () => {
    const dir = tmpdir();
    const crashing = new Store(dir, { failpoints: [fp] });
    assert.throws(() => ingestEvents(crashing, batch()), /injected failure/);

    // simulate process restart: fresh instance sees only what hit disk
    const restored = new Store(dir);
    recoverAndFinalize(restored);
    const expected = cleanRun();

    if (fp === 'before-log') {
      // crash before the events hit disk: nothing durable, client must retry
      assert.equal(restored.readLog().length, 0);
      const retry = new Store(dir);
      const r = ingestEvents(retry, batch());
      assert.equal(r.applied, 6);
      assert.deepEqual(retry.state.lots, expected.lots);
      return;
    }

    assert.deepEqual(restored.state.lots, expected.lots, 'lot state matches clean run');
    assert.deepEqual(restored.state.devices, expected.devices, 'device state matches clean run');
    assert.equal(restored.state.lots.L1.total, 10, 'scan quantities applied exactly once');
    assert.equal(restored.state.lots.L1.transitions, 2, 'hold/release applied exactly once');
    assert.equal(restored.state.appliedSeq, 6);
    assert.equal(restored.readLog().length, 6);

    // recovery is idempotent: a second resume changes nothing
    const again = new Store(dir);
    const report2 = recoverAndFinalize(again);
    assert.equal(report2.recovery.applied.length, 0);
    assert.deepEqual(again.state.lots, expected.lots);

    // ingest after recovery must not re-apply the crashed batch
    const post = new Store(dir);
    const r = ingestEvents(post, batch());
    assert.equal(r.applied, 0);
    assert.equal(r.duplicates, 6);
    assert.equal(post.state.lots.L1.total, 10);
  });
}

test('crash mid-stream: second batch recovers on top of committed first batch', () => {
  const dir = tmpdir();
  const s1 = new Store(dir);
  ingestEvents(s1, batch());

  const crashing = new Store(dir, { failpoints: ['after-index'] });
  const more = [
    ev({ id: 's3', ts: 7, kind: 'quality.scan', payload: { result: 'pass', qty: 1 } }),
    ev({ id: 'h2', ts: 8, kind: 'quality.hold', payload: {} }),
  ];
  assert.throws(() => ingestEvents(crashing, more), /injected failure/);

  const restored = new Store(dir);
  recoverAndFinalize(restored);
  assert.equal(restored.state.lots.L1.total, 11);
  assert.equal(restored.state.lots.L1.status, 'held');
  assert.equal(restored.state.appliedSeq, 8);
});
