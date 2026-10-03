import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeWorkspace,
  writeEvents,
  runCli,
  readJsonl,
  readFile,
  sensor,
} from '../testlib/helpers.js';

test('duplicate events are idempotent by id', () => {
  const events = [
    sensor('p0', 0, 'pressure', 1200),
    sensor('t0', 0, 'temperature', 200),
    sensor('p2', 2000, 'pressure', 1200),
    sensor('t2', 2000, 'temperature', 200),
    sensor('p6', 6000, 'pressure', 1200),
    sensor('t6', 6000, 'temperature', 200),
  ];
  const single = makeWorkspace();
  writeEvents(single.inDir, events);
  const runSingle = runCli(single.inDir, single.outDir);
  assert.equal(runSingle.status, 0, runSingle.stderr);
  const doubled = makeWorkspace();
  writeEvents(doubled.inDir, [...events, ...events]);
  const runDoubled = runCli(doubled.inDir, doubled.outDir);
  assert.equal(runDoubled.status, 0, runDoubled.stderr);
  assert.equal(
    readFile(path.join(doubled.outDir, 'states.jsonl')),
    readFile(path.join(single.outDir, 'states.jsonl')),
  );
  const proof = JSON.parse(
    fs.readFileSync(path.join(doubled.outDir, 'proof.json'), 'utf8'),
  );
  assert.equal(proof.counts.duplicates, events.length);
  assert.equal(proof.counts.sensor, events.length);
});

test('sensor without unit reports UNIT_MISSING and is ignored', () => {
  const { inDir, outDir } = makeWorkspace();
  writeEvents(inDir, [
    { type: 'sensor', id: 'p-nounit', eventTs: 0, tag: 'pressure', value: 1200, seq: 0 },
    sensor('t0', 0, 'temperature', 200),
    sensor('p4', 4000, 'pressure', 1200),
    sensor('t4', 4000, 'temperature', 200),
  ]);
  const result = runCli(inDir, outDir);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /UNIT_MISSING/);
  const proof = JSON.parse(
    fs.readFileSync(path.join(outDir, 'proof.json'), 'utf8'),
  );
  assert.equal(proof.counts.unitMissing, 1);
  assert.equal(proof.counts.sensor, 3);
  assert.ok(proof.diagnostics.some((d) => d.code === 'UNIT_MISSING' && d.id === 'p-nounit'));
  const states = readJsonl(path.join(outDir, 'states.jsonl'));
  assert.ok(
    !states.some((s) => s.state === 'ARM' && s.since === 0),
    'unit-less sample must not start the condition run',
  );
});

test('bad json lines are diagnosed, not fatal', () => {
  const { inDir, outDir } = makeWorkspace();
  writeEvents(inDir, [
    '{not json',
    sensor('p0', 0, 'pressure', 1200),
    sensor('t0', 0, 'temperature', 200),
    sensor('p4', 4000, 'pressure', 500),
  ]);
  const result = runCli(inDir, outDir);
  assert.equal(result.status, 0);
  const proof = JSON.parse(
    fs.readFileSync(path.join(outDir, 'proof.json'), 'utf8'),
  );
  assert.equal(proof.counts.bad, 1);
  assert.ok(proof.diagnostics.some((d) => d.code === 'BAD_JSON'));
});
