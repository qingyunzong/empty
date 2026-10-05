import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/crdt.js';
import { computeOee, partitionBySkew, HoldInFinalStateError } from '../src/oee.js';

const SHIFT_START = '2026-10-05T08:00:00Z';
const SHIFT_END = '2026-10-05T16:00:00Z';
const OPTS = { plannedMinutes: 480, idealRatePerMin: 1, shiftStart: SHIFT_START, shiftEnd: SHIFT_END };

function shiftEvents() {
  return [
    { type: 'count', id: 'c1', terminal: 'A', key: 'produced', delta: 200 },
    { type: 'count', id: 'c2', terminal: 'B', key: 'produced', delta: 150 },
    { type: 'count', id: 'c3', terminal: 'A', key: 'rejected', delta: 10 },
    { type: 'count', id: 'c4', terminal: 'B', key: 'rejected', delta: 5 },
    { type: 'down', id: 'd1', start: '2026-10-05T09:00:00Z', end: '2026-10-05T09:30:00Z' },
    { type: 'down', id: 'd2', start: '2026-10-05T09:15:00Z', end: '2026-10-05T09:45:00Z' },
    { type: 'down', id: 'd3', start: '2026-10-05T13:00:00Z', end: '2026-10-05T13:20:00Z' },
  ];
}

test('acceptance 1: any sharding merged equals the full merge (state and OEE)', () => {
  const events = shiftEvents();
  const reference = computeOee(new Store(events), OPTS);
  const referenceJSONL = new Store(events).toJSONL();

  for (let mask = 0; mask < 2 ** events.length; mask += 1) {
    const left = new Store(events.filter((_, i) => mask & (1 << i)));
    const right = new Store(events.filter((_, i) => !(mask & (1 << i))));
    const merged = new Store().merge(left).merge(right);
    assert.equal(merged.toJSONL(), referenceJSONL);
    assert.deepEqual(computeOee(merged, OPTS), reference);
  }

  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 50; trial += 1) {
    const k = 2 + Math.floor(rand() * 4);
    const shards = Array.from({ length: k }, () => new Store());
    for (const event of events) shards[Math.floor(rand() * k)].add(event);
    const merged = Store.mergeAll(shards);
    assert.equal(merged.toJSONL(), referenceJSONL);
    assert.deepEqual(computeOee(merged, OPTS), reference);
  }
});

test('acceptance 2: revoking a downtime returns OEE to the independent reference', () => {
  const events = shiftEvents();
  const withDown = computeOee(new Store(events), OPTS);
  const reference = computeOee(new Store(events.filter((e) => e.id !== 'd3')), OPTS);
  assert.notEqual(withDown.downtimeMinutes, reference.downtimeMinutes);

  const revoked = new Store([...events, { type: 'undo', id: 'u1', target: 'd3' }]);
  const after = computeOee(revoked, OPTS);
  assert.deepEqual(after, reference);
  assert.equal(after.downtimeMinutes, 45);
});

test('acceptance 3: tombstones make deletion idempotent and permanent', () => {
  const down = { type: 'down', id: 'd1', start: '2026-10-05T09:00:00Z', end: '2026-10-05T09:30:00Z' };
  const undo1 = { type: 'undo', id: 'u1', target: 'd1' };
  const undo2 = { type: 'undo', id: 'u2', target: 'd1' };

  const once = new Store([down, undo1]);
  const twice = new Store([down, undo1, undo1]);
  const duplicated = new Store([down, undo1, undo2]);
  assert.equal(once.liveDowntimes().length, 0);
  assert.ok(once.equals(twice));
  assert.equal(duplicated.liveDowntimes().length, 0);

  const resurrected = new Store([down, undo1]);
  resurrected.add(down);
  assert.equal(resurrected.liveDowntimes().length, 0);

  const a = new Store([undo1]);
  const b = new Store([down]);
  assert.equal(new Store().merge(a).merge(b).liveDowntimes().length, 0);
  assert.equal(new Store().merge(b).merge(a).liveDowntimes().length, 0);
});

test('rejects are clamped to production (quality never negative)', () => {
  const store = new Store([
    { type: 'count', id: 'c1', terminal: 'A', key: 'produced', delta: 10 },
    { type: 'count', id: 'c2', terminal: 'A', key: 'rejected', delta: 25 },
  ]);
  const result = computeOee(store, OPTS);
  assert.equal(result.rejected, 10);
  assert.equal(result.rejectedClamped, true);
  assert.equal(result.quality, 0);
});

test('OEE factors match hand-computed values', () => {
  const store = new Store(shiftEvents());
  const result = computeOee(store, OPTS);
  assert.equal(result.downtimeMinutes, 65);
  assert.ok(Math.abs(result.available - 415 / 480) < 1e-12);
  assert.ok(Math.abs(result.performance - 350 / 415) < 1e-12);
  assert.ok(Math.abs(result.quality - 335 / 350) < 1e-12);
  assert.ok(Math.abs(result.oee - result.available * result.performance * result.quality) < 1e-12);
});

test('out-of-skew events go to hold and are excluded from loss and violations', () => {
  const now = Date.parse('2026-10-05T16:05:00Z');
  const maxSkewMs = 5 * 60 * 1000;
  const events = [
    { type: 'count', id: 'ok', terminal: 'A', key: 'produced', delta: 100, ts: '2026-10-05T16:04:00Z' },
    { type: 'down', id: 'late', start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z', ts: '2026-10-05T10:00:00Z' },
    { type: 'count', id: 'future', terminal: 'A', key: 'rejected', delta: 999, ts: '2026-10-05T20:00:00Z' },
  ];
  const { accepted, held } = partitionBySkew(events, { now, maxSkewMs });
  assert.deepEqual(accepted.map((e) => e.id), ['ok']);
  assert.deepEqual(held.map((e) => e.id).sort(), ['future', 'late']);

  const store = new Store(accepted);
  const result = computeOee(store, { ...OPTS, pending: held, allowPending: true });
  assert.equal(result.downtimeMinutes, 0);
  assert.equal(result.rejected, 0);
  assert.equal(result.rejectedClamped, false);
  assert.deepEqual(result.pending.sort(), ['future', 'late']);
});

test('finalizing with pending hold events is refused (exit-11 condition)', () => {
  const store = new Store([{ type: 'count', id: 'c1', terminal: 'A', key: 'produced', delta: 1 }]);
  const pending = [{ type: 'down', id: 'late', start: SHIFT_START, end: SHIFT_END, holdReason: 'clock-skew-out-of-bounds' }];
  assert.throws(() => computeOee(store, { ...OPTS, pending }), HoldInFinalStateError);
  const result = computeOee(store, { ...OPTS, pending, allowPending: true });
  assert.equal(result.downtimeMinutes, 0);
});
