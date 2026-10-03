import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeWorkspace,
  writeEvents,
  runCli,
  readJsonl,
  sensor,
  aliveStates,
} from '../testlib/helpers.js';

function readProof(outDir) {
  return JSON.parse(fs.readFileSync(path.join(outDir, 'proof.json'), 'utf8'));
}

test('late low sample revokes false ARM/TRIP with reverse compensation', () => {
  const { inDir, outDir } = makeWorkspace();
  writeEvents(inDir, [
    sensor('p0', 0, 'pressure', 1200),
    sensor('t0', 0, 'temperature', 200),
    { type: 'trip', id: 'trip1', eventTs: 4000, channel: 'PT-1', state: 'TRIPPED' },
    sensor('p5', 5000, 'pressure', 1200),
    sensor('t5', 5000, 'temperature', 200),
    // Arrives after the watermark passed 2500: breaks the 3s continuity that
    // had produced ARM@3000 and TRIP@4000.
    sensor('p-late', 2500, 'pressure', 500),
  ]);
  const result = runCli(inDir, outDir, { args: ['--window-ms', '10000'] });
  assert.equal(result.status, 0, result.stderr);

  const states = readJsonl(path.join(outDir, 'states.jsonl'));
  const ops = states.map((s) => `${s.op}:${s.state}@${s.ts}`);
  assert.deepEqual(ops, [
    'EMIT:ARM@3000',
    'EMIT:TRIP@4000',
    'REVOKE:ARM@3000',
    'REVOKE:TRIP@4000',
    'EMIT:ARM@8000',
    'EMIT:DISARM@15000',
  ]);

  const alive = aliveStates(states);
  assert.ok(!alive.some((s) => s.state === 'TRIP'), 'false TRIP must be gone');
  assert.ok(alive.some((s) => s.state === 'ARM' && s.ts === 8000));

  const late = readJsonl(path.join(outDir, 'late.log'));
  assert.equal(late.length, 1);
  assert.equal(late[0].id, 'p-late');
  assert.equal(late[0].reason, 'LATE_EVENT');

  const proof = readProof(outDir);
  assert.equal(proof.trips.length, 0);
  assert.equal(proof.conclusion, 'NO_PROVEN_TRIP');
  assert.equal(proof.counts.late, 1);
});

test('retracting a suppressing sample restores the earlier ARM', () => {
  const { inDir, outDir } = makeWorkspace();
  writeEvents(inDir, [
    sensor('p0', 0, 'pressure', 1200),
    sensor('t0', 0, 'temperature', 200),
    sensor('p-low', 1000, 'pressure', 500),
    sensor('p2', 2000, 'pressure', 1200),
    sensor('t2', 2000, 'temperature', 200),
    sensor('p4', 4000, 'pressure', 1200),
    sensor('t4', 4000, 'temperature', 200),
    sensor('p6', 6000, 'pressure', 1200),
    sensor('t6', 6000, 'temperature', 200),
    { type: 'retract', eventTs: 7000, kind: 'sensor', id: 'p-low' },
  ]);
  const result = runCli(inDir, outDir);
  assert.equal(result.status, 0, result.stderr);

  const states = readJsonl(path.join(outDir, 'states.jsonl'));
  const ops = states.map((s) => `${s.op}:${s.state}@${s.ts}`);
  assert.deepEqual(ops, [
    'EMIT:ARM@5000',
    'REVOKE:ARM@5000',
    'EMIT:ARM@3000',
    'EMIT:DISARM@8000',
  ]);

  const alive = aliveStates(states);
  assert.ok(alive.some((s) => s.state === 'ARM' && s.ts === 3000 && s.since === 0));
});

test('sustained over-limit combination proves the trip (positive case)', () => {
  const { inDir, outDir } = makeWorkspace();
  writeEvents(inDir, [
    sensor('p0', 0, 'pressure', 1200),
    sensor('t0', 0, 'temperature', 200),
    { type: 'trip', id: 'trip1', eventTs: 4000, channel: 'PT-1', state: 'TRIPPED' },
    sensor('p5', 5000, 'pressure', 1200),
    sensor('t5', 5000, 'temperature', 200),
  ]);
  const result = runCli(inDir, outDir, { args: ['--window-ms', '10000'] });
  assert.equal(result.status, 0, result.stderr);

  const states = readJsonl(path.join(outDir, 'states.jsonl'));
  const alive = aliveStates(states);
  const trip = alive.find((s) => s.state === 'TRIP');
  assert.ok(trip, 'TRIP must stay alive');
  assert.equal(trip.ts, 4000);
  assert.equal(trip.armTs, 3000);

  const proof = readProof(outDir);
  assert.equal(proof.conclusion, 'TRIP_CAUSED_BY_PT_COMBINATION');
  assert.equal(proof.trips.length, 1);
  assert.equal(proof.trips[0].tripId, 'trip1');
  assert.equal(proof.trips[0].heldMs, 4000);
  assert.ok(proof.trips[0].evidence.pressureSamples.length > 0);
  assert.ok(proof.trips[0].evidence.temperatureSamples.length > 0);
});
