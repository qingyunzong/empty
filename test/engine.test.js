import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, FREEZE_AFTER_SECONDS } from '../src/engine.js';
import { referenceRun } from '../src/reference.js';

function run(engine, events) {
  return events.flatMap((e) => engine.process(e));
}

const simplify = (actions) =>
  actions.map((a) => [a.action, a.code ?? null, a.metricId ?? null, a.batchId ?? null]);

test('acceptance: late-arriving batch flips a metric from UNMATCHED to MATCHED', () => {
  const engine = createEngine();
  const actions = run(engine, [
    { type: 'READ_METRIC', metricId: 'm1', batchId: 'b1', ts: 150, yield: 900, quality: 0.9 },
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 100, end: 200, version: 1 },
  ]);
  assert.deepEqual(simplify(actions), [
    ['UNMATCHED', null, 'm1', 'b1'],
    ['ADD', null, 'm1', 'b1'],
  ]);
  const cert = engine.certificate();
  assert.equal(cert.metrics[0].state, 'MATCHED');
  assert.equal(cert.counts.matched, 1);
});

test('acceptance: shrinking a batch excludes the tail metric and cascades WITHDRAW', () => {
  const engine = createEngine();
  const actions = run(engine, [
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 100, version: 1 },
    { type: 'READ_METRIC', metricId: 'm-head', batchId: 'b1', ts: 10, yield: 100, quality: 0.5 },
    { type: 'READ_METRIC', metricId: 'm-tail', batchId: 'b1', ts: 90, yield: 200, quality: 0.7 },
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 50, version: 2 },
  ]);
  assert.deepEqual(simplify(actions), [
    ['ADD', null, 'm-head', 'b1'],
    ['ADD', null, 'm-tail', 'b1'],
    ['WITHDRAW', null, 'm-tail', 'b1'],
  ]);
  const cert = engine.certificate();
  const states = Object.fromEntries(cert.metrics.map((m) => [m.metricId, m.state]));
  assert.deepEqual(states, { 'm-head': 'MATCHED', 'm-tail': 'UNMATCHED' });
  assert.deepEqual(cert.batches[0].versions, [1, 2], 'interval history must be preserved');
  assert.equal(cert.counts.withdraw, 1);
});

test('acceptance: retraction cascades WITHDRAW to all matched metrics', () => {
  const engine = createEngine();
  const actions = run(engine, [
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 100, version: 1 },
    { type: 'READ_METRIC', metricId: 'm1', batchId: 'b1', ts: 10, yield: 1, quality: 0.1 },
    { type: 'READ_METRIC', metricId: 'm2', batchId: 'b1', ts: 20, yield: 1, quality: 0.2 },
    { type: 'BATCH', batchId: 'b1', op: 'RETRACT' },
  ]);
  assert.deepEqual(simplify(actions), [
    ['ADD', null, 'm1', 'b1'],
    ['ADD', null, 'm2', 'b1'],
    ['WITHDRAW', null, 'm1', 'b1'],
    ['WITHDRAW', null, 'm2', 'b1'],
  ]);
  assert.equal(engine.certificate().batches[0].retracted, true);
});

test('acceptance: correction after the freeze horizon is rejected with LATE', () => {
  const engine = createEngine();
  const ts = 100;
  const actions = run(engine, [
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 200, version: 1 },
    { type: 'READ_METRIC', metricId: 'm1', batchId: 'b1', ts, yield: 1, quality: 0.9 },
    { type: 'WATERMARK', ts: ts + FREEZE_AFTER_SECONDS + 1 },
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 150, end: 300, version: 2 },
  ]);
  assert.deepEqual(simplify(actions), [
    ['ADD', null, 'm1', 'b1'],
    ['ERROR', 'LATE', 'm1', 'b1'],
  ]);
  const cert = engine.certificate();
  assert.equal(cert.metrics[0].state, 'MATCHED', 'frozen metric must not migrate');
  assert.equal(cert.metrics[0].frozen, true);
  assert.equal(cert.batches[0].version, 2, 'version history still advances');
});

test('metric stays unfrozen exactly at the freeze boundary (watermark == ts + 30)', () => {
  const engine = createEngine();
  const actions = run(engine, [
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 200, version: 1 },
    { type: 'READ_METRIC', metricId: 'm1', batchId: 'b1', ts: 100, yield: 1, quality: 0.9 },
    { type: 'WATERMARK', ts: 130 },
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 150, end: 300, version: 2 },
  ]);
  assert.deepEqual(simplify(actions), [
    ['ADD', null, 'm1', 'b1'],
    ['WITHDRAW', null, 'm1', 'b1'],
  ]);
});

test('invalid transitions report dedicated error codes', () => {
  const engine = createEngine();
  const actions = run(engine, [
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 50, end: 50, version: 1 },
    { type: 'BATCH', batchId: 'b2', op: 'UPSERT', start: 10, end: 5, version: 1 },
    { type: 'READ_METRIC', metricId: 'm1', batchId: 'b1', ts: 1, yield: 1, quality: 1.5 },
    { type: 'READ_METRIC', metricId: 'm2', batchId: 'b1', ts: 1, yield: 1, quality: -0.1 },
    { type: 'BATCH', batchId: 'ghost', op: 'RETRACT' },
  ]);
  assert.deepEqual(simplify(actions), [
    ['ERROR', 'INVALID_RANGE', null, 'b1'],
    ['ERROR', 'INVALID_RANGE', null, 'b2'],
    ['ERROR', 'INVALID_QUALITY', 'm1', 'b1'],
    ['ERROR', 'INVALID_QUALITY', 'm2', 'b1'],
    ['ERROR', 'UNKNOWN_RETRACT', null, 'ghost'],
  ]);
  const cert = engine.certificate();
  assert.equal(cert.counts.batches, 0);
  assert.equal(cert.counts.metrics, 0);
  assert.equal(cert.counts.error, 5);
});

test('lower or equal batch versions are rejected with STALE_VERSION', () => {
  const engine = createEngine();
  const actions = run(engine, [
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 100, version: 2 },
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 50, version: 1 },
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 60, version: 2 },
  ]);
  assert.deepEqual(simplify(actions), [
    ['ERROR', 'STALE_VERSION', null, 'b1'],
    ['ERROR', 'STALE_VERSION', null, 'b1'],
  ]);
  const cert = engine.certificate();
  assert.equal(cert.batches[0].version, 2);
  assert.deepEqual(cert.batches[0].interval, { start: 0, end: 100 });
});

test('quality boundaries 0 and 1 are valid', () => {
  const engine = createEngine();
  const actions = run(engine, [
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 10, version: 1 },
    { type: 'READ_METRIC', metricId: 'm0', batchId: 'b1', ts: 1, yield: 1, quality: 0 },
    { type: 'READ_METRIC', metricId: 'm1', batchId: 'b1', ts: 2, yield: 1, quality: 1 },
  ]);
  assert.deepEqual(simplify(actions), [
    ['ADD', null, 'm0', 'b1'],
    ['ADD', null, 'm1', 'b1'],
  ]);
});

test('interval end is exclusive: ts == end does not match', () => {
  const engine = createEngine();
  const actions = run(engine, [
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 100, version: 1 },
    { type: 'READ_METRIC', metricId: 'm-edge', batchId: 'b1', ts: 100, yield: 1, quality: 0.5 },
  ]);
  assert.deepEqual(simplify(actions), [['UNMATCHED', null, 'm-edge', 'b1']]);
});

test('certificate lists all member ids, versions and counts', () => {
  const engine = createEngine();
  run(engine, [
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 100, version: 1 },
    { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 80, version: 2 },
    { type: 'BATCH', batchId: 'b2', op: 'UPSERT', start: 500, end: 600, version: 1 },
    { type: 'READ_METRIC', metricId: 'm1', batchId: 'b1', ts: 10, yield: 1, quality: 0.9 },
    { type: 'READ_METRIC', metricId: 'm2', batchId: 'b2', ts: 10, yield: 1, quality: 0.9 },
  ]);
  const cert = engine.certificate();
  assert.equal(cert.type, 'CERTIFICATE');
  assert.deepEqual(cert.batches.map((b) => b.batchId).sort(), ['b1', 'b2']);
  assert.deepEqual(cert.batches.find((b) => b.batchId === 'b1').versions, [1, 2]);
  assert.deepEqual(cert.metrics.map((m) => m.metricId).sort(), ['m1', 'm2']);
  assert.deepEqual(cert.counts, {
    batches: 2,
    metrics: 2,
    matched: 1,
    unmatched: 1,
    add: 1,
    withdraw: 0,
    error: 0,
  });
});

// --- Differential test: incremental engine vs brute-force reference ---------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateEvents(rng, count) {
  const events = [];
  const lastVersion = new Map();
  let watermark = 0;
  let metricSeq = 0;
  const pickBatch = () => `b${Math.floor(rng() * 3)}`;
  for (let i = 0; i < count; i += 1) {
    const r = rng();
    if (r < 0.3) {
      const batchId = pickBatch();
      const start = Math.floor(rng() * 100);
      const end = start + Math.floor(rng() * 60) - (rng() < 0.1 ? 100 : 0); // ~10% invalid ranges
      const base = lastVersion.get(batchId) ?? 0;
      const version = base + (rng() < 0.75 ? 1 : Math.floor(rng() * 3) - 1); // sometimes stale
      lastVersion.set(batchId, Math.max(base, version));
      events.push({ type: 'BATCH', batchId, op: 'UPSERT', start, end, version });
    } else if (r < 0.4) {
      const batchId = rng() < 0.85 ? pickBatch() : 'ghost'; // sometimes unknown
      events.push({ type: 'BATCH', batchId, op: 'RETRACT' });
    } else if (r < 0.8) {
      metricSeq += 1;
      const quality = rng() < 0.9 ? rng() : (rng() < 0.5 ? -0.5 : 1.5); // ~10% invalid
      events.push({
        type: 'READ_METRIC',
        metricId: `m${metricSeq}`,
        batchId: pickBatch(),
        ts: Math.floor(rng() * 160),
        yield: Math.floor(rng() * 1000),
        quality,
      });
    } else {
      watermark += Math.floor(rng() * 40);
      events.push({ type: 'WATERMARK', ts: watermark });
    }
  }
  return events;
}

const normalize = (actions) =>
  actions.map((a) => [a.action, a.code ?? null, a.metricId ?? null, a.batchId ?? null]);

test('differential: engine matches brute-force reference across random streams', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const events = generateEvents(mulberry32(seed), 60);
    const engine = createEngine();
    const engineActions = events.flatMap((e) => engine.process(e));
    const ref = referenceRun(events);

    const engineRelevant = engineActions.filter((a) =>
      a.action !== 'ERROR' || a.code === 'LATE');
    assert.deepEqual(
      normalize(engineRelevant),
      normalize(ref.actions),
      `action stream mismatch for seed ${seed}`,
    );

    const cert = engine.certificate();
    for (const m of cert.metrics) {
      assert.equal(
        m.state,
        ref.finalStates.get(m.metricId),
        `final state of ${m.metricId} mismatch for seed ${seed}`,
      );
    }
  }
});
