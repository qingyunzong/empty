import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

function setup(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fill-release-'));
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  mkdirSync(inDir);
  writeFileSync(path.join(inDir, 'events.jsonl'), lines.join('\n') + '\n');
  return { inDir, outDir };
}

function runCli(argv) {
  const io = { out: '', err: '' };
  const code = run(argv, {
    stdout: { write: (s) => { io.out += s; } },
    stderr: { write: (s) => { io.err += s; } },
  });
  return { code, ...io };
}

const readJsonl = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

const MIN = 60 * 1000;
const EVENTS = [
  JSON.stringify({ type: 'cip', eventTs: 0, line: 'L1', start: -2000, end: -1000, ok: true, op: 'cip-0' }),
  JSON.stringify({ type: 'fill', eventTs: 1000, batch: 'B1', vol: 500, weight: 500, op: 'f1' }),
  JSON.stringify({ type: 'lab', eventTs: 2000, batch: 'B1', pass: true, op: 'l1' }),
  JSON.stringify({ type: 'retract', eventTs: 3000, kind: 'lab', id: 'l1' }),
  JSON.stringify({ type: 'fill', eventTs: 1000, batch: 'B2', vol: 500, weight: 100, op: 'f2' }), // density 0.2
  JSON.stringify({ type: 'lab', eventTs: 2500, batch: 'B2', pass: true, op: 'l2' }),
  JSON.stringify({ type: 'fill', eventTs: 1000, batch: 'B3', vol: 0, weight: 500, op: 'f3' }), // VOL_INVALID
  JSON.stringify({ type: 'fill', eventTs: 1000, batch: 'B4', vol: 500, weight: 500, op: 'f4' }), // stays HOLD then late lab
  JSON.stringify({ type: 'cip', eventTs: 10 * MIN, line: 'L1', start: 11 * MIN, end: 12 * MIN, ok: true, op: 'cip-1' }),
  JSON.stringify({ type: 'lab', eventTs: 1500, batch: 'B4', pass: true, op: 'l4' }), // late lab
];

test('fill release writes all four outputs with correct states', () => {
  const { inDir, outDir } = setup(EVENTS);
  const r = runCli(['release', '--in', inDir, '--out', outDir]);
  assert.equal(r.code, 0);
  assert.match(r.out, /processed 10 events/);

  for (const f of ['batches.jsonl', 'transitions.jsonl', 'comp.jsonl', 'late.log']) {
    assert.ok(existsSync(path.join(outDir, f)), `missing ${f}`);
  }

  const batches = Object.fromEntries(readJsonl(path.join(outDir, 'batches.jsonl')).map((b) => [b.batch, b]));
  assert.equal(batches.B1.state, 'HOLD');   // lab retracted -> rolled back
  assert.equal(batches.B2.state, 'REJECT'); // density contradiction, lab cannot flip
  assert.equal(batches.B2.reason, 'DENSITY_MISMATCH');
  assert.equal(batches.B3.state, 'REJECT');
  assert.equal(batches.B3.reason, 'VOL_INVALID');
  assert.equal(batches.B4.state, 'RELEASE'); // late lab still releases
  assert.deepEqual(batches.B1.window, { start: 1000, end: 1000 });

  const transitions = readJsonl(path.join(outDir, 'transitions.jsonl'));
  const b1path = transitions.filter((t) => t.batch === 'B1').map((t) => `${t.from}->${t.to}`);
  assert.deepEqual(b1path, ['EMPTY->HOLD', 'HOLD->RELEASE', 'RELEASE->HOLD']);
  assert.ok(transitions.every((t, i) => i === 0 || t.seq > transitions[i - 1].seq));

  const comp = readJsonl(path.join(outDir, 'comp.jsonl'));
  assert.equal(comp.length, 1);
  assert.equal(comp[0].retractedId, 'l1');
  assert.equal(comp[0].from, 'RELEASE');
  assert.equal(comp[0].to, 'HOLD');

  const late = readJsonl(path.join(outDir, 'late.log'));
  assert.ok(late.some((l) => l.op === 'l4' && l.reason === 'LATE_LAB_WINDOW_CLOSED'));
});

test('CLI reports malformed input with file:line and exit code 2', () => {
  const { inDir, outDir } = setup(['{"type":"fill","eventTs":1}']);
  const r = runCli(['release', '--in', inDir, '--out', outDir]);
  assert.equal(r.code, 2);
  assert.match(r.err, /missing field "batch"/);
  assert.match(r.err, /events\.jsonl:1/);
});

test('CLI rejects bad usage with exit code 1', () => {
  assert.equal(runCli(['release']).code, 1);
  assert.equal(runCli(['bogus', '--in', 'x', '--out', 'y']).code, 1);
  assert.equal(runCli(['release', '--in', '/nonexistent-dir-xyz', '--out', 'y']).code, 1);
});
