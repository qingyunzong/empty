import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/app.js';

function writeJsonl(dir, name, events) {
  const path = join(dir, name);
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

const base = [
  { id: 'a1', member: 'alpha', epoch: 1, seq: 1, type: 'join', clock: { alpha: 1 } },
  { id: 'a2', member: 'alpha', epoch: 1, seq: 2, type: 'interlock', clock: { alpha: 2 } },
];

test('CLI merge prints final state and certificate, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boiler-'));
  const f = writeJsonl(dir, 'a.jsonl', base);
  const res = runCli(['merge', f]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.state.valve, 'CLOSED');
  assert.ok(out.certificate.stateHash);
  assert.ok(out.certificate.digest.hash);
});

test('CLI merge with unknown member exits 4', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boiler-'));
  const f = writeJsonl(dir, 'bad.jsonl', [
    ...base,
    { id: 'x1', member: 'ghost', epoch: 1, seq: 1, type: 'reset', clock: { ghost: 1 } },
  ]);
  const res = runCli(['merge', f]);
  assert.equal(res.code, 4);
  assert.match(res.stderr, /unknown member "ghost"/);
});

test('CLI digest with mismatched logs exits 5 and reports divergence interval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boiler-'));
  const f1 = writeJsonl(dir, 'full.jsonl', base);
  const f2 = writeJsonl(dir, 'partial.jsonl', [base[0]]);
  const res = runCli(['digest', f1, f2]);
  assert.equal(res.code, 5);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error, 'digest mismatch');
  assert.deepEqual(err.divergence[0].members.alpha.interval, [2, 2]);
});

test('CLI digest with identical logs exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boiler-'));
  const f1 = writeJsonl(dir, 'one.jsonl', base);
  const f2 = writeJsonl(dir, 'two.jsonl', [...base].reverse());
  const res = runCli(['digest', f1, f2]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).equal, true);
});

test('CLI status prints valve state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boiler-'));
  const f = writeJsonl(dir, 's.jsonl', [
    ...base,
    { id: 'a3', member: 'alpha', epoch: 1, seq: 3, type: 'reset', clock: { alpha: 3 } },
  ]);
  const res = runCli(['status', f]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).valve, 'OPEN');
});
