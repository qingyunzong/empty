import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FluxEngine } from '../src/engine.js';

const MIN = 60 * 1000;

function flux(id, ts, value, sensorId = 'gh-1') {
  return { type: 'FLUX', op: 'UPSERT', id, sensorId, ts, value };
}

function calibration(id, version, effectiveFrom, expireAt, factor, sensorId = 'gh-1') {
  return {
    type: 'CALIBRATION',
    op: 'UPSERT',
    id,
    sensorId,
    version,
    effectiveFrom,
    expireAt,
    factor,
  };
}

function retract(type, id) {
  return { type, op: 'RETRACT', id };
}

function lastAddFor(outputs, pane) {
  const adds = outputs.filter((o) => o.type === 'ADD' && o.pane === pane);
  return adds[adds.length - 1] ?? null;
}

test('out-of-order samples spanning two calibration versions produce time-weighted flux', () => {
  const engine = new FluxEngine();
  const outputs = [];
  const feed = (event) => outputs.push(...engine.ingest(event));

  feed(calibration('cal-low', 1, 0, 10 * MIN, 2));
  feed(calibration('cal-high', 2, 10 * MIN, 20 * MIN, 4));

  // Arrive out of order; all land in pane gh-1#0 = [0, 15min).
  feed(flux('s3', 12 * MIN, 30));
  feed(flux('s1', 2 * MIN, 10));
  feed(flux('s2', 8 * MIN, 20));

  const pane = lastAddFor(outputs, 'gh-1#0');
  assert.ok(pane, 'pane gh-1#0 must be emitted');
  assert.equal(pane.windowStart, 0);
  assert.equal(pane.windowEnd, 15 * MIN);
  assert.equal(pane.status, 'CALIBRATED');
  assert.deepEqual(
    pane.segments.map((s) => s.version),
    [1, 2],
  );
  assert.deepEqual(
    pane.segments.map((s) => s.samples),
    [
      ['s1', 's2'],
      ['s3'],
    ],
  );
  // Voronoi weights: 300000 / 300000 / 300000 -> (10*2 + 20*2 + 30*4) / 3 = 60
  assert.equal(pane.weightedFlux, 60);
  assert.deepEqual(pane.evidence, ['s1', 's2', 's3']);
});

test('retracting the highest calibration version falls back to the lower version', () => {
  const engine = new FluxEngine();
  const outputs = [];
  const feed = (event) => outputs.push(...engine.ingest(event));

  feed(calibration('cal-v1', 1, 0, 15 * MIN, 2));
  feed(calibration('cal-v2', 2, 0, 15 * MIN, 3));
  feed(flux('s1', 5 * MIN, 10));
  feed(flux('s2', 10 * MIN, 20));

  const before = lastAddFor(outputs, 'gh-1#0');
  // Overlapping ranges: highest version (v2, factor 3) wins -> (10*3 + 20*3) / 2 = 45
  assert.equal(before.weightedFlux, 45);
  assert.deepEqual(
    before.segments.map((s) => s.version),
    [2],
  );

  const retractOutputs = engine.ingest(retract('CALIBRATION', 'cal-v2'));
  const withdraw = retractOutputs.find((o) => o.type === 'WITHDRAW' && o.pane === 'gh-1#0');
  assert.ok(withdraw, 'retract must withdraw the previous pane result');
  assert.equal(withdraw.weightedFlux, 45);

  const after = lastAddFor(retractOutputs, 'gh-1#0');
  // Falls back to v1 (factor 2) -> (10*2 + 20*2) / 2 = 30
  assert.equal(after.weightedFlux, 30);
  assert.deepEqual(
    after.segments.map((s) => s.version),
    [1],
  );
});

test('retracting the only calibration restores UNCALIBRATED state', () => {
  const engine = new FluxEngine();
  engine.ingest(calibration('cal-only', 1, 0, 15 * MIN, 2));
  engine.ingest(flux('s1', 5 * MIN, 10));
  const outputs = engine.ingest(retract('CALIBRATION', 'cal-only'));
  const pane = lastAddFor(outputs, 'gh-1#0');
  assert.equal(pane.status, 'UNCALIBRATED');
  assert.equal(pane.weightedFlux, 10);
  assert.deepEqual(
    pane.segments.map((s) => s.version),
    [null],
  );
});

test('records arriving after a pane is frozen are rejected as LATE', () => {
  const engine = new FluxEngine();
  engine.ingest(flux('s1', 0, 5));
  // Push the watermark past windowEnd (15min) + 1min lateness.
  engine.ingest(flux('s2', 16 * MIN + 1, 5));

  const outputs = engine.ingest(flux('s-late', 100, 99));
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].type, 'ERROR');
  assert.equal(outputs[0].code, 'LATE');
  assert.equal(outputs[0].record.id, 's-late');
  // Frozen pane keeps its last emitted result.
  assert.deepEqual(engine.paneState.get('gh-1#0').evidence, ['s1']);
});

test('corrections before the watermark closes a pane incrementally recompute it', () => {
  const engine = new FluxEngine();
  engine.ingest(flux('s1', 5 * MIN, 10));
  const outputs = engine.ingest(retract('FLUX', 's1'));
  const withdraw = outputs.find((o) => o.type === 'WITHDRAW' && o.pane === 'gh-1#0');
  assert.ok(withdraw, 'removing the last sample must withdraw the pane');
  assert.equal(engine.paneState.has('gh-1#0'), false);
});

test('retracting an unknown record reports UNKNOWN_RETRACT', () => {
  const engine = new FluxEngine();
  const outputs = engine.ingest(retract('FLUX', 'nope'));
  assert.equal(outputs[0].type, 'ERROR');
  assert.equal(outputs[0].code, 'UNKNOWN_RETRACT');
});

test('reversed calibration range reports INVALID_RANGE', () => {
  const engine = new FluxEngine();
  const outputs = engine.ingest(calibration('bad', 1, 10 * MIN, 5 * MIN, 2));
  assert.equal(outputs[0].type, 'ERROR');
  assert.equal(outputs[0].code, 'INVALID_RANGE');
});

test('malformed input reports MALFORMED', () => {
  const engine = new FluxEngine();
  const badJson = engine.ingestLine('{not json');
  assert.equal(badJson[0].code, 'MALFORMED');

  const missingValue = engine.ingest({ type: 'FLUX', op: 'UPSERT', id: 'x', sensorId: 'gh-1', ts: 0 });
  assert.equal(missingValue[0].code, 'MALFORMED');

  const badType = engine.ingest({ type: 'NOPE', id: 'x' });
  assert.equal(badType[0].code, 'MALFORMED');
});

test('upsert replaces a sample in place and recomputes overlapping panes', () => {
  const engine = new FluxEngine();
  engine.ingest(flux('s1', 5 * MIN, 10));
  const outputs = engine.ingest(flux('s1', 5 * MIN, 20));
  const withdraw = outputs.find((o) => o.type === 'WITHDRAW' && o.pane === 'gh-1#0');
  assert.ok(withdraw);
  assert.equal(withdraw.weightedFlux, 10);
  const pane = lastAddFor(outputs, 'gh-1#0');
  assert.equal(pane.weightedFlux, 20);
});
