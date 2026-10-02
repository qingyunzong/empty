import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, Line, ERR } from '../src/index.js';

test('acceptance 2: clock rollback beyond maxSkew -> ERR_CLOCK, state unchanged', () => {
  const line = new Line({ maxSkewMs: 1000 });
  assert.equal(line.ingest([{ id: 'a', type: 'run', start: 10_000, end: 20_000 }]).ok, true);
  assert.equal(line.ingest([{ id: 'b', type: 'idle', start: 9_500, end: 10_000 }]).ok, true); // within skew
  const before = structuredClone(line.events);
  const bad = line.ingest([{ id: 'c', type: 'fault', start: 5_000, end: 6_000 }]); // 5000 < 10000-1000
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, ERR.CLOCK);
  assert.deepEqual(line.events, before); // state unchanged
  // line still analyzable, result identical to before the failed ingest
  assert.equal(line.analyze().ok, true);
});

test('rollback inside a single batch rejects the whole batch', () => {
  const r = analyze({
    events: [
      { id: 'a', type: 'run', start: 100_000, end: 200_000 },
      { id: 'b', type: 'fault', start: 0, end: 50_000 },
    ],
    params: { maxSkewMs: 10_000 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, ERR.CLOCK);
});

test('out-of-order within maxSkew is tolerated and normalized', () => {
  const r = analyze({
    events: [
      { id: 'a', type: 'run', start: 10_000, end: 20_000 },
      { id: 'b', type: 'fault', start: 5_000, end: 7_000 },
    ],
    params: { maxSkewMs: 10_000 },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.timeline.map((s) => s.state), ['fault', 'uncovered', 'run']);
});
