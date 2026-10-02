import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { hist } from './helpers.js';

const EXAMPLES = new URL('../examples/', import.meta.url).pathname;

// The sandbox forbids spawning subprocesses, so the CLI is exercised
// in-process with captured streams.
function run(args) {
  let stdout = '';
  let stderr = '';
  const status = runCli(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { status, stdout, stderr };
}

test('exit 0 and CONCURRENT_OK on the three-device example', () => {
  const r = run(['--config', join(EXAMPLES, 'config.json'), ...['devA.jsonl', 'devB.jsonl', 'devC.jsonl'].map((f) => join(EXAMPLES, f))]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'CONCURRENT_OK');
  assert.deepEqual(out.matrix, { Q1: { FES: 3, POA: 1, ROS: 1 }, Q2: { FES: 1, POA: 2 } });
});

test('exit 6 and CONFLICT with a minimal cycle on the cycle example', () => {
  const r = run(['--config', join(EXAMPLES, 'config.json'), join(EXAMPLES, 'cycle/devA.jsonl'), join(EXAMPLES, 'cycle/devB.jsonl')]);
  assert.equal(r.status, 6, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'CONFLICT');
  assert.equal(out.reason, 'CAUSAL_CYCLE');
  assert.equal(out.cycle.length, 4);
});

test('exit 2 on INVALID_HISTORY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eco-merge-'));
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(
    bad,
    '{"op":"set_count","device":"A","time":2,"plot":"Q1","species":"FES","tier":1}\n{"op":"set_count","device":"A","time":1,"plot":"Q1","species":"FES","tier":2}\n',
  );
  const r = run(['--config', join(EXAMPLES, 'config.json'), bad]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error, 'INVALID_HISTORY');
  assert.ok(err.details.length >= 1);
});

test('exit 4 on PENDING and never judges conflict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eco-merge-'));
  const big = join(dir, 'big.jsonl');
  const ops = Array.from({ length: 100 }, () => ({ op: 'set_count', plot: 'Q1', species: 'FES', tier: 1 }));
  writeFileSync(big, hist('A', ...ops) + '\n');
  const r = run(['--config', join(EXAMPLES, 'config.json'), '--budget', '5', big]);
  assert.equal(r.status, 4);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'PENDING');
  assert.ok(!('conflicts' in out) && !('cycle' in out));
});
