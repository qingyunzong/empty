import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00Z');

function flux(id, minute, value, sensorId = 'gh-1') {
  return {
    type: 'FLUX',
    op: 'UPSERT',
    id,
    sensorId,
    ts: new Date(T0 + minute * MIN).toISOString(),
    value,
  };
}

function calibration(id, version, fromMin, toMin, factor, offset = 0, sensorId = 'gh-1') {
  return {
    type: 'CALIBRATION',
    op: 'UPSERT',
    id,
    sensorId,
    version,
    effectiveFrom: new Date(T0 + fromMin * MIN).toISOString(),
    expireAt: new Date(T0 + toMin * MIN).toISOString(),
    factor,
    offset,
  };
}

function retract(type, id) {
  return { type, op: 'RETRACT', id };
}

function outputsForPane(outputs, paneStartMin, sensorId = 'gh-1') {
  const start = new Date(T0 + paneStartMin * MIN).toISOString();
  const end = new Date(T0 + (paneStartMin + 15) * MIN).toISOString();
  const paneId = `${sensorId}@${start}/${end}`;
  return outputs.filter((output) => output.pane === paneId);
}

function lastAddForPane(engine, paneStartMin, sensorId = 'gh-1') {
  return engine.panes.get(`${sensorId}|${T0 + paneStartMin * MIN}`)?.emitted ?? null;
}

test('out-of-order samples spanning two calibration versions produce time-weighted flux', () => {
  const engine = new Engine();
  engine.ingest(calibration('c1', 1, 0, 30, 1));
  engine.ingest(calibration('c2', 2, 10, 20, 2));

  const all = [];
  all.push(...engine.ingest(flux('s2', 12, 10)));
  all.push(...engine.ingest(flux('s3', 14, 10)));
  all.push(...engine.ingest(flux('s1', 2, 10)));

  const paneOutputs = outputsForPane(all, 0);
  assert.ok(paneOutputs.length > 0);
  const finalAdd = paneOutputs.filter((o) => o.type === 'ADD').at(-1);

  // Voronoi weights in pane [00:00,00:15): s1=7min, s2=6min, s3=2min.
  // s1 calibrated by v1 (x1) -> 10; s2, s3 calibrated by v2 (x2) -> 20.
  // (7*10 + 6*20 + 2*20) / 15 = 15.333333
  assert.equal(finalAdd.weightedFlux, 15.333333);
  assert.equal(finalAdd.uncalibrated, false);
  assert.deepEqual(finalAdd.evidence, ['s1', 's2', 's3']);
  assert.deepEqual(
    finalAdd.segments.map((s) => s.version),
    [1, 2],
  );
  assert.equal(finalAdd.segments[0].from, '2026-01-01T00:00:00.000Z');
  assert.equal(finalAdd.segments[0].to, '2026-01-01T00:10:00.000Z');
  assert.equal(finalAdd.segments[1].from, '2026-01-01T00:10:00.000Z');
  assert.equal(finalAdd.segments[1].to, '2026-01-01T00:15:00.000Z');
});

test('retracting the highest calibration version restores the next-highest version', () => {
  const engine = new Engine();
  engine.ingest(calibration('c1', 1, 0, 30, 1));
  engine.ingest(calibration('c2', 2, 0, 30, 10));
  engine.ingest(flux('s1', 0, 1));
  engine.ingest(flux('s2', 10, 1));

  const before = lastAddForPane(engine, 0);
  assert.equal(before.weightedFlux, 10);
  assert.deepEqual(
    before.segments.map((s) => s.version),
    [2],
  );

  const outputs = engine.ingest(retract('CALIBRATION', 'c2'));
  const paneOutputs = outputsForPane(outputs, 0);
  const withdraw = paneOutputs.find((o) => o.type === 'WITHDRAW');
  const add = paneOutputs.find((o) => o.type === 'ADD');
  assert.ok(withdraw, 'expected WITHDRAW of the v2-based result');
  assert.equal(withdraw.weightedFlux, 10);
  assert.ok(add, 'expected ADD of the v1-based result');
  assert.equal(add.weightedFlux, 1);
  assert.deepEqual(
    add.segments.map((s) => s.version),
    [1],
  );
});

test('retracting the only calibration restores UNCALIBRATED state', () => {
  const engine = new Engine();
  engine.ingest(calibration('c1', 1, 0, 30, 4));
  engine.ingest(flux('s1', 5, 2));
  const before = lastAddForPane(engine, 0);
  assert.equal(before.weightedFlux, 8);
  assert.equal(before.uncalibrated, false);

  const outputs = engine.ingest(retract('CALIBRATION', 'c1'));
  const add = outputsForPane(outputs, 0).find((o) => o.type === 'ADD');
  assert.ok(add);
  assert.equal(add.weightedFlux, 2);
  assert.equal(add.uncalibrated, true);
  assert.deepEqual(
    add.segments.map((s) => s.version),
    [null],
  );
});

test('insert after pane freeze is rejected with LATE', () => {
  const engine = new Engine();
  engine.ingest(flux('s1', 0, 5));
  engine.ingest(flux('s2', 120, 5));

  const outputs = engine.ingest(flux('s3', 1, 9));
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].type, 'ERROR');
  assert.equal(outputs[0].code, 'LATE');
  assert.equal(outputs[0].id, 's3');
  assert.equal(engine.samples.has('s3'), false);

  const pane = lastAddForPane(engine, 0);
  assert.deepEqual(pane.evidence, ['s1']);
});

test('upsert correction before freeze emits WITHDRAW then ADD', () => {
  const engine = new Engine();
  engine.ingest(flux('s1', 0, 10));
  const outputs = engine.ingest(flux('s1', 0, 20));
  const paneOutputs = outputsForPane(outputs, 0);
  assert.equal(paneOutputs[0].type, 'WITHDRAW');
  assert.equal(paneOutputs[0].weightedFlux, 10);
  assert.equal(paneOutputs[1].type, 'ADD');
  assert.equal(paneOutputs[1].weightedFlux, 20);
});

test('retracting a sample updates evidence of overlapping panes', () => {
  const engine = new Engine();
  engine.ingest(flux('s1', 0, 10));
  engine.ingest(flux('s2', 5, 20));
  const outputs = engine.ingest(retract('FLUX', 's2'));
  const add = outputsForPane(outputs, 0).find((o) => o.type === 'ADD');
  assert.ok(add);
  assert.deepEqual(add.evidence, ['s1']);
  assert.equal(add.weightedFlux, 10);
});

test('sample without any calibration is flagged UNCALIBRATED', () => {
  const engine = new Engine();
  const outputs = engine.ingest(flux('s1', 0, 5));
  const add = outputsForPane(outputs, 0).find((o) => o.type === 'ADD');
  assert.ok(add);
  assert.equal(add.weightedFlux, 5);
  assert.equal(add.uncalibrated, true);
  assert.deepEqual(
    add.segments.map((s) => s.version),
    [null],
  );
});

test('error codes: UNKNOWN_RETRACT, INVALID_RANGE, MALFORMED', () => {
  const engine = new Engine();

  let [output] = engine.ingest(retract('FLUX', 'nope'));
  assert.equal(output.code, 'UNKNOWN_RETRACT');
  [output] = engine.ingest(retract('CALIBRATION', 'nope'));
  assert.equal(output.code, 'UNKNOWN_RETRACT');

  [output] = engine.ingest(calibration('c1', 1, 10, 10, 1));
  assert.equal(output.code, 'INVALID_RANGE');
  [output] = engine.ingest(calibration('c2', 1, 20, 10, 1));
  assert.equal(output.code, 'INVALID_RANGE');

  [output] = engine.ingest({ type: 'FLUX', op: 'UPSERT', id: 'b1', sensorId: 'gh-1', ts: 'junk', value: 1 });
  assert.equal(output.code, 'MALFORMED');
  [output] = engine.ingest({ type: 'FLUX', op: 'UPSERT', id: 'b2', sensorId: 'gh-1', ts: T0, value: 'x' });
  assert.equal(output.code, 'MALFORMED');
  [output] = engine.ingest({ type: 'FLUX', op: 'DELETE', id: 'b3' });
  assert.equal(output.code, 'MALFORMED');
  [output] = engine.ingest({ type: 'MYSTERY', op: 'UPSERT', id: 'b4' });
  assert.equal(output.code, 'MALFORMED');
  [output] = engine.ingest({ type: 'CALIBRATION', op: 'UPSERT', id: 'b5', sensorId: 'gh-1', version: 1, effectiveFrom: T0, expireAt: T0 + MIN, factor: NaN });
  assert.equal(output.code, 'MALFORMED');
});

test('hopping windows: a sample contributes to three overlapping panes', () => {
  const engine = new Engine();
  const outputs = engine.ingest(flux('s1', 7, 3));
  const adds = outputs.filter((o) => o.type === 'ADD');
  assert.equal(adds.length, 3);
  const starts = adds.map((o) => o.windowStart).sort();
  assert.deepEqual(starts, [
    '2025-12-31T23:55:00.000Z',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:05:00.000Z',
  ]);
});
