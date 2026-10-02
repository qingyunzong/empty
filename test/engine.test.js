import test from 'node:test';
import assert from 'node:assert/strict';
import { LimitEngine, ERR } from '../src/engine.js';
import { refOccupancyAt, refCheckTimeline } from '../src/ref.js';
import { scenario1, scenario2, scenario3, scenario4 } from '../src/scenarios.js';

test('S1: three overlapping freezes across period resets', () => {
  const r = scenario1();
  assert.ok(r.log[0].ok && r.log[1].ok && r.log[2].ok);
  assert.equal(r.occupancy.beforeReset_t59.total, 850);
  assert.equal(r.occupancy.afterReset_t61.total, 900);
  const capture = r.log[3];
  assert.ok(capture.ok);
  const capSeg = capture.state.segments.find((s) => s.start <= 55 && 55 < s.end);
  assert.equal(capSeg.total, 850);
  const afterResetSeg = capture.state.segments.find((s) => s.start <= 60 && 60 < s.end);
  assert.equal(afterResetSeg.total, 900);
  assert.equal(afterResetSeg.captures.length, 0);
  const sweep = r.log[4];
  assert.deepEqual(sweep.released.sort(), ['A', 'B']);
  const seg130 = sweep.state.segments.find((s) => s.start <= 130 && 130 < s.end);
  assert.equal(seg130.total, 200);
  assert.deepEqual(seg130.holds.map((h) => h.id), ['C']);
});

test('S1b: limit rejection is E_LIMIT and does not partially deduct', () => {
  const engine = new LimitEngine({ totalLimit: 100, dailyCaps: { X: 60 }, periodMinutes: 60, dayMinutes: 120 });
  assert.ok(engine.apply({ op: 'freeze', id: 'a', category: 'X', amount: 50, start: 0, end: 30 }).ok);
  const before = engine.version;
  const r1 = engine.apply({ op: 'freeze', id: 'b', category: 'X', amount: 60, start: 10, end: 20 });
  assert.equal(r1.code, ERR.LIMIT);
  assert.equal(r1.detail.kind, 'total');
  const r2 = engine.apply({ op: 'freeze', id: 'c', category: 'X', amount: 20, start: 0, end: 30 });
  assert.equal(r2.code, ERR.LIMIT);
  assert.equal(r2.detail.kind, 'daily');
  assert.equal(engine.version, before);
  assert.equal(engine.occupancyAt(15).total, 50);
});

test('S2: partial unfreeze splits interval, refill merges with proof', () => {
  const r = scenario2();
  assert.deepEqual(r.proof.splitSegments, [[0, 40], [60, 100]]);
  assert.equal(r.fragmentsAfterSplit.length, 2);
  assert.deepEqual(r.proof.occupantSegments, [[0, 40], [40, 60], [60, 100]]);
  assert.deepEqual(r.proof.mergedSegments, [[0, 100]]);
  assert.equal(r.proof.mergeProof.length, 2);
  assert.deepEqual(r.proof.mergeProof[0].into, [0, 60]);
  assert.deepEqual(r.proof.mergeProof[1].into, [0, 100]);
  const merged = r.log[2].state.coalesced[0];
  assert.equal(merged.total, 100);
  const occupantIds = r.log[2].state.segments.flatMap((s) => s.holds.map((h) => h.id));
  assert.deepEqual([...new Set(occupantIds)].sort(), ['H', 'H2']);
});

test('S2b: amount-partial capture reduces middle fragment', () => {
  const engine = new LimitEngine({ totalLimit: 500, dailyCaps: {}, periodMinutes: 240, dayMinutes: 240 });
  engine.apply({ op: 'freeze', id: 'H', category: 'M', amount: 100, start: 0, end: 100 });
  const r = engine.apply({ op: 'capture', id: 'H', start: 40, end: 60, amount: 30, at: 10 });
  assert.ok(r.ok);
  const mid = r.state.segments.find((s) => s.start === 40 && s.end === 60);
  assert.equal(mid.total, 100);
  assert.equal(mid.holds[0].amount, 70);
  assert.equal(mid.captures[0].amount, 30);
});

test('S3: concurrent equal requests, deterministic single winner', () => {
  const r = scenario3();
  const winners = r.forward.filter((x) => x.ok);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].op, 'freeze r1');
  const losers = r.forward.filter((x) => !x.ok);
  assert.equal(losers.length, 2);
  for (const l of losers) assert.equal(l.code, ERR.LIMIT);
  assert.ok(r.deterministic);
  assert.equal(r.staleVersionRejected.code, ERR.RACE);
});

test('S3b: priority beats submission order', () => {
  const engine = new LimitEngine({ totalLimit: 100, dailyCaps: {}, periodMinutes: 60, dayMinutes: 120 });
  const results = engine.applyBatch([
    { op: 'freeze', id: 'low', category: 'M', amount: 60, start: 0, end: 30, priority: 1, seq: 1 },
    { op: 'freeze', id: 'high', category: 'M', amount: 60, start: 0, end: 30, priority: 9, seq: 2 },
  ]);
  const byId = Object.fromEntries(results.map((x) => [x.op.split(' ')[1], x]));
  assert.ok(byId.high.ok);
  assert.equal(byId.low.code, ERR.LIMIT);
});

test('S4: minute-by-minute cross-check vs reference implementation', () => {
  const r = scenario4();
  assert.equal(r.result.mismatches, 0);
  assert.equal(r.result.violations.length, 0);
  assert.ok(r.result.maxOccupancy <= r.result.totalLimit);
  assert.ok(r.timeline.acceptedFreezes > 0);
  assert.ok(r.timeline.rejectedFreezes > 0);
});

test('validation errors: E_INTERVAL and E_PERIOD', () => {
  const engine = new LimitEngine({ totalLimit: 100, dailyCaps: {}, periodMinutes: 60, dayMinutes: 120 });
  assert.equal(engine.apply({ op: 'freeze', id: 'a', category: 'M', amount: 10, start: 50, end: 50 }).code, ERR.INTERVAL);
  assert.equal(engine.apply({ op: 'freeze', id: 'a', category: 'M', amount: -5, start: 0, end: 10 }).code, ERR.INTERVAL);
  assert.equal(engine.apply({ op: 'unfreeze', id: 'ghost', start: 0, end: 10 }).code, ERR.INTERVAL);
  assert.ok(engine.apply({ op: 'freeze', id: 'a', category: 'M', amount: 10, start: 0, end: 30 }).ok);
  assert.equal(engine.apply({ op: 'freeze', id: 'a', category: 'M', amount: 10, start: 0, end: 10 }).code, ERR.INTERVAL);
  engine.apply({ op: 'sweep', at: 70 });
  assert.equal(engine.apply({ op: 'freeze', id: 'b', category: 'M', amount: 10, start: 10, end: 80 }).code, ERR.PERIOD);
  assert.equal(engine.apply({ op: 'sweep', at: 60 }).code, ERR.INTERVAL);
});

test('auto-release at expiry via sweep and half-open semantics', () => {
  const engine = new LimitEngine({ totalLimit: 100, dailyCaps: {}, periodMinutes: 60, dayMinutes: 120 });
  engine.apply({ op: 'freeze', id: 'a', category: 'M', amount: 40, start: 10, end: 20 });
  assert.equal(engine.occupancyAt(9).total, 0);
  assert.equal(engine.occupancyAt(10).total, 40);
  assert.equal(engine.occupancyAt(19).total, 40);
  assert.equal(engine.occupancyAt(20).total, 0);
  const s = engine.apply({ op: 'sweep', at: 20 });
  assert.deepEqual(s.released, ['a']);
  assert.equal(engine.holds.length, 0);
});

test('cross-period carryover: hold spans reset, capture expires at reset', () => {
  const cfg = { totalLimit: 500, dailyCaps: {}, periodMinutes: 60, dayMinutes: 120, anchor: 0 };
  const engine = new LimitEngine(cfg);
  engine.apply({ op: 'freeze', id: 'carry', category: 'M', amount: 100, start: 30, end: 90 });
  engine.apply({ op: 'freeze', id: 'tmp', category: 'M', amount: 50, start: 10, end: 40 });
  engine.apply({ op: 'capture', id: 'tmp', start: 10, end: 40, at: 20 });
  assert.equal(engine.occupancyAt(59).total, 150);
  assert.equal(engine.occupancyAt(60).total, 100);
  assert.equal(refOccupancyAt(engine.holds, engine.captures, 60, cfg).total, 100);
  const ref = refCheckTimeline(engine.holds, engine.captures, cfg, 0, 120);
  assert.equal(ref.violations.length, 0);
});
