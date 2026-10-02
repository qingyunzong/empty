import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';

const T = (min) => `2026-01-01T00:${String(min).padStart(2, '0')}:00Z`;

function setup(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'demand-'));
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  mkdirSync(inDir);
  writeFileSync(path.join(inDir, 'events.jsonl'), lines.join('\n') + '\n');
  return { inDir, outDir };
}

function runCli(args) {
  const out = [];
  const err = [];
  const io = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  };
  return main(args, io).then((code) => ({ code, stdout: out.join(''), stderr: err.join('') }));
}

test('CLI audit writes windows.jsonl, settlement.json, comp.jsonl, late.log', async () => {
  const { inDir, outDir } = setup([
    JSON.stringify({ type: 'tariff', eventTs: T(0), name: 'r0', start: T(0), end: T(15), rate: 2 }),
    JSON.stringify({ type: 'meter', eventTs: T(0), meter: 'M1', kwh: 0, estimated: false }),
    JSON.stringify({ type: 'meter', eventTs: T(15), meter: 'M1', kwh: 25, estimated: true }),
    JSON.stringify({ type: 'retract', eventTs: T(20), kind: 'meter', id: `M1@${new Date(T(15)).toISOString()}` }),
    JSON.stringify({ type: 'meter', eventTs: T(15), meter: 'M1', kwh: 10, estimated: false }),
    JSON.stringify({ type: 'shed', eventTs: T(14), load: 'HVAC', kw: 30 }),
  ]);
  const { code, stdout } = await runCli(['audit', '--in', inDir, '--out', outDir]);
  assert.equal(code, 0);
  assert.match(stdout, /audited 1 window/);

  const files = readdirSync(outDir).sort();
  assert.deepEqual(files, ['comp.jsonl', 'late.log', 'settlement.json', 'windows.jsonl']);

  const windows = readFileSync(path.join(outDir, 'windows.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kwh, 10);
  assert.equal(windows[0].estimated, false);

  const settlement = JSON.parse(readFileSync(path.join(outDir, 'settlement.json'), 'utf8'));
  assert.equal(settlement.peak.grossKw, 40);
  assert.equal(settlement.corrections, 1);
  assert.equal(settlement.exhaustive.verified, true);

  const comp = readFileSync(path.join(outDir, 'comp.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(comp.some((c) => c.type === 'meter_retract'));

  const late = readFileSync(path.join(outDir, 'late.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(late.length >= 1);
  assert.ok(late.every((l) => l.watermark));
});

test('CLI exits 1 with METER_ROLLBACK on stderr for decreasing kwh', async () => {
  const { inDir, outDir } = setup([
    JSON.stringify({ type: 'meter', eventTs: T(0), meter: 'M1', kwh: 100, estimated: false }),
    JSON.stringify({ type: 'meter', eventTs: T(15), meter: 'M1', kwh: 90, estimated: false }),
  ]);
  const { code, stderr } = await runCli(['audit', '--in', inDir, '--out', outDir]);
  assert.equal(code, 1);
  assert.match(stderr, /METER_ROLLBACK/);
});

test('CLI exits 1 with BAD_JSON for malformed input lines', async () => {
  const { inDir, outDir } = setup(['{"type":"meter"', 'not json']);
  const { code, stderr } = await runCli(['audit', '--in', inDir, '--out', outDir]);
  assert.equal(code, 1);
  assert.match(stderr, /BAD_JSON/);
});
