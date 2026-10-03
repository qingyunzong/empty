import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WindowEngine,
  paneStartsFor,
  PANE_WIDTH_MS,
  PANE_SLIDE_MS,
  FINALIZE_DELAY_MS,
  MAX_VERSIONS_PER_SAMPLE,
} from '../src/engine.js';
import { runReference } from '../reference/reference.js';

const ALIGNED = 1_700_000_000_000 - (1_700_000_000_000 % PANE_SLIDE_MS);

function upsert(sampleId, ts, temp, sensorId = 's1') {
  return { type: 'UPSERT', sensorId, sampleId, ts, temp };
}

test('a sample lands in exactly 5 overlapping panes', () => {
  for (let offset = 0; offset < PANE_SLIDE_MS; offset += 30_000) {
    const starts = paneStartsFor(ALIGNED + offset);
    assert.equal(starts.length, PANE_WIDTH_MS / PANE_SLIDE_MS);
    for (const start of starts) {
      assert.equal(start % PANE_SLIDE_MS, 0);
      assert.ok(start <= ALIGNED + offset && ALIGNED + offset < start + PANE_WIDTH_MS);
    }
  }
});

test('out-of-order sample incrementally updates all 5 overlapping panes', () => {
  const engine = new WindowEngine();
  const first = engine.ingest(upsert('a', ALIGNED, 20));
  assert.deepEqual(first.errors, []);
  assert.equal(first.outputs.filter((o) => o.op === 'ADD').length, 5);

  engine.ingest(upsert('b', ALIGNED + 60_000, 22));
  const wm = engine.ingest({ type: 'WATERMARK', ts: ALIGNED + 30_000 });
  assert.equal(wm.outputs.filter((o) => o.op === 'FINAL').length, 0, 'no pane finalized yet');

  const late = engine.ingest(upsert('c', ALIGNED - 30_000, 21));
  assert.deepEqual(late.errors, []);
  const affected = new Set(late.outputs.map((o) => o.paneStart));
  assert.equal(affected.size, 5, 'all 5 overlapping panes react to the late sample');
  assert.equal(late.outputs.filter((o) => o.op === 'ADD').length, 1, 'one brand-new pane');
  assert.equal(late.outputs.filter((o) => o.op === 'WITHDRAW').length, 4);
  assert.equal(late.outputs.filter((o) => o.op === 'CORRECTION').length, 4);
  for (const output of late.outputs) {
    if (output.op === 'WITHDRAW') continue;
    assert.equal(output.median, 21);
    assert.ok(typeof output.certificate === 'string' && output.certificate.length === 64);
  }
  const corrections = late.outputs.filter((o) => o.op === 'CORRECTION');
  const withdrawals = late.outputs.filter((o) => o.op === 'WITHDRAW');
  for (const correction of corrections) {
    const withdrawn = withdrawals.find((w) => w.paneStart === correction.paneStart);
    assert.ok(withdrawn, 'every CORRECTION is preceded by a WITHDRAW of the same pane');
    assert.notEqual(withdrawn.certificate, correction.certificate);
  }
});

test('correction of a sample recomputes every overlapping pane', () => {
  const engine = new WindowEngine();
  engine.ingest(upsert('a', ALIGNED, 20));
  engine.ingest(upsert('b', ALIGNED, 24));
  const corrected = engine.ingest(upsert('b', ALIGNED, 21));
  assert.deepEqual(corrected.errors, []);
  const corrections = corrected.outputs.filter((o) => o.op === 'CORRECTION');
  assert.equal(corrections.length, 5);
  for (const output of corrections) {
    assert.equal(output.median, 20.5);
    assert.deepEqual(output.outlierIds, []);
  }
});

test('retracting an outlier yields a tied median and fewer outliers', () => {
  const engine = new WindowEngine();
  const points = [
    ['p1', 19.8],
    ['p2', 20],
    ['p3', 20.1],
    ['p4', 20.2],
    ['p5', 35],
  ];
  let last;
  for (const [id, temp] of points) last = engine.ingest(upsert(id, ALIGNED, temp));
  const before = last.outputs.filter((o) => o.op === 'CORRECTION' || o.op === 'ADD');
  assert.equal(before.length, 5);
  for (const output of before) {
    assert.ok(Math.abs(output.median - 20.1) < 1e-9);
    assert.deepEqual(output.outlierIds, ['p5']);
  }

  const retracted = engine.ingest({ type: 'RETRACT', sensorId: 's1', sampleId: 'p5' });
  assert.deepEqual(retracted.errors, []);
  const corrections = retracted.outputs.filter((o) => o.op === 'CORRECTION');
  assert.equal(corrections.length, 5);
  for (const output of corrections) {
    assert.ok(Math.abs(output.median - 20.05) < 1e-9, 'tied median averages the two middle values');
    assert.ok(Math.abs(output.mad - 0.1) < 1e-9);
    assert.deepEqual(output.outlierIds, [], 'outlier count drops to zero');
  }
});

test('version budget beyond 8 updates is rejected with BUDGET_EXCEEDED', () => {
  const engine = new WindowEngine();
  for (let version = 1; version <= MAX_VERSIONS_PER_SAMPLE; version += 1) {
    const result = engine.ingest(upsert('x', ALIGNED, 20 + version));
    assert.deepEqual(result.errors, [], `version ${version} accepted`);
  }
  const rejected = engine.ingest(upsert('x', ALIGNED, 99));
  assert.equal(rejected.outputs.length, 0);
  assert.equal(rejected.errors.length, 1);
  assert.equal(rejected.errors[0].error, 'BUDGET_EXCEEDED');
  assert.equal(rejected.errors[0].sampleId, 'x');
  const other = engine.ingest(upsert('y', ALIGNED, 21));
  assert.deepEqual(other.errors, [], 'budget is tracked per sample, not per sensor');
});

test('modifications after finalization are rejected with LATE', () => {
  const engine = new WindowEngine();
  engine.ingest(upsert('a', ALIGNED, 20));
  const wm = engine.ingest({ type: 'WATERMARK', ts: ALIGNED + PANE_WIDTH_MS + FINALIZE_DELAY_MS });
  const finals = wm.outputs.filter((o) => o.op === 'FINAL');
  assert.equal(finals.length, 5);
  for (const output of finals) {
    assert.equal(output.sensorId, 's1');
    assert.equal(output.median, 20);
    assert.deepEqual(output.outlierIds, []);
    assert.ok(output.certificate);
  }

  const lateUpsert = engine.ingest(upsert('b', ALIGNED + 10_000, 21));
  assert.equal(lateUpsert.errors[0]?.error, 'LATE');
  assert.equal(lateUpsert.outputs.length, 0);

  const lateCorrection = engine.ingest(upsert('a', ALIGNED, 25));
  assert.equal(lateCorrection.errors[0]?.error, 'LATE');

  const lateRetract = engine.ingest({ type: 'RETRACT', sensorId: 's1', sampleId: 'a' });
  assert.equal(lateRetract.errors[0]?.error, 'LATE');

  const fresh = engine.ingest(upsert('c', ALIGNED + PANE_WIDTH_MS + FINALIZE_DELAY_MS + 1, 19));
  assert.deepEqual(fresh.errors, [], 'samples in non-finalized panes still accepted');
});

test('retracting an unknown sample is rejected with UNKNOWN_RETRACT', () => {
  const engine = new WindowEngine();
  const result = engine.ingest({ type: 'RETRACT', sensorId: 's1', sampleId: 'ghost' });
  assert.equal(result.errors[0]?.error, 'UNKNOWN_RETRACT');
  engine.ingest(upsert('a', ALIGNED, 20));
  const otherSensor = engine.ingest({ type: 'RETRACT', sensorId: 's2', sampleId: 'a' });
  assert.equal(otherSensor.errors[0]?.error, 'UNKNOWN_RETRACT');
});

test('retracting the last sample withdraws the pane result', () => {
  const engine = new WindowEngine();
  engine.ingest(upsert('a', ALIGNED, 20));
  const result = engine.ingest({ type: 'RETRACT', sensorId: 's1', sampleId: 'a' });
  assert.deepEqual(result.errors, []);
  const withdrawals = result.outputs.filter((o) => o.op === 'WITHDRAW');
  assert.equal(withdrawals.length, 5);
  const wm = engine.ingest({ type: 'WATERMARK', ts: ALIGNED + PANE_WIDTH_MS + FINALIZE_DELAY_MS });
  const finals = wm.outputs.filter((o) => o.op === 'FINAL');
  assert.equal(finals.length, 5);
  for (const output of finals) {
    assert.equal(output.median, null);
    assert.deepEqual(output.outlierIds, []);
  }
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEvents(seed, count) {
  const rng = mulberry32(seed);
  const base = ALIGNED;
  const events = [];
  const knownIds = [];
  let watermark = base - 600_000;
  let counter = 0;
  for (let i = 0; i < count; i += 1) {
    const roll = rng();
    const sensorId = `s${1 + Math.floor(rng() * 3)}`;
    if (roll < 0.6) {
      let sampleId;
      if (knownIds.length > 0 && rng() < 0.35) {
        sampleId = knownIds[Math.floor(rng() * knownIds.length)];
      } else {
        counter += 1;
        sampleId = `sample-${counter}`;
        knownIds.push(sampleId);
      }
      const ts = base + Math.floor(rng() * 40) * 30_000;
      const temp = Math.round((18 + rng() * 6) * 100) / 100 + (rng() < 0.08 ? 8 : 0);
      events.push({ type: 'UPSERT', sensorId, sampleId, ts, temp });
    } else if (roll < 0.75) {
      const sampleId =
        knownIds.length > 0 && rng() < 0.8
          ? knownIds[Math.floor(rng() * knownIds.length)]
          : `ghost-${Math.floor(rng() * 5)}`;
      events.push({ type: 'RETRACT', sensorId, sampleId });
    } else {
      watermark += Math.floor(rng() * 5) * 45_000;
      if (rng() < 0.3) {
        events.push({ type: 'WATERMARK', sensorId, ts: watermark });
      } else {
        events.push({ type: 'WATERMARK', ts: watermark });
      }
    }
  }
  events.push({ type: 'WATERMARK', ts: base + 100 * 60_000 });
  return events;
}

test('randomized streams match the independent brute-force reference', () => {
  for (const seed of [1, 7, 42, 1337, 20261004]) {
    const events = randomEvents(seed, 400);
    const engine = new WindowEngine();
    const engineFinals = new Map();
    const engineErrors = [];
    for (const event of events) {
      const { outputs, errors } = engine.ingest(event);
      engineErrors.push(...errors.map((e) => e.error));
      for (const output of outputs) {
        if (output.op === 'FINAL') {
          engineFinals.set(`${output.sensorId}|${output.paneStart}`, {
            median: output.median,
            mad: output.mad,
            outlierIds: output.outlierIds,
          });
        }
      }
    }
    const reference = runReference(events);
    assert.deepEqual(engineErrors, reference.errors.map((e) => e.error), `error stream (seed ${seed})`);
    assert.equal(engineFinals.size, reference.finalPanes.size, `finalized pane count (seed ${seed})`);
    for (const [key, expected] of reference.finalPanes) {
      assert.deepEqual(engineFinals.get(key), expected, `pane ${key} (seed ${seed})`);
    }
  }
});
