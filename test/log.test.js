import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppendOnlyLog, LogError } from '../src/log.js';

test('append-only log assigns contiguous seq and freezes records', () => {
  const log = new AppendOnlyLog();
  const r0 = log.append({ id: 'e0', ts: 1, src: 'safety', kind: 'estop' });
  const r1 = log.append({ id: 'e1', ts: 2, src: 'plc', kind: 'reset_ack' });
  assert.equal(r0.seq, 0);
  assert.equal(r1.seq, 1);
  assert.equal(log.size, 2);
  assert.throws(() => {
    r0.kind = 'photo';
  }, TypeError);
});

test('sequence gap is rejected with ERR_GAP', () => {
  const log = new AppendOnlyLog();
  log.append({ seq: 0, id: 'e0', ts: 1, src: 'safety', kind: 'estop' });
  assert.throws(
    () => log.append({ seq: 5, id: 'e1', ts: 2, src: 'safety', kind: 'estop' }),
    (err) => err instanceof LogError && err.code === 'ERR_GAP',
  );
  // the failed append must not corrupt the log
  assert.equal(log.size, 1);
});

test('clock inversion per source is rejected with ERR_CLOCK', () => {
  const log = new AppendOnlyLog();
  log.append({ id: 'e0', ts: 10, src: 'cylinder', kind: 'cyl_done' });
  assert.throws(
    () => log.append({ id: 'e1', ts: 9, src: 'cylinder', kind: 'cyl_done' }),
    (err) => err instanceof LogError && err.code === 'ERR_CLOCK',
  );
  // a different source with its own clock is unaffected
  log.append({ id: 'e2', ts: 3, src: 'safety', kind: 'estop' });
  assert.equal(log.size, 2);
});
