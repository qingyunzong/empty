import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../cli.js';

function runCli(argv) {
  const out = { stdout: '', stderr: '' };
  const io = {
    stdout: { write: (s) => { out.stdout += s; } },
    stderr: { write: (s) => { out.stderr += s; } },
  };
  const status = run(['node', 'cli.js', ...argv], io);
  return { status, ...out, json: out.stdout ? JSON.parse(out.stdout) : null };
}

function runCliWithPlan(plan) {
  const dir = mkdtempSync(join(tmpdir(), 'shrink-test-'));
  const file = join(dir, 'plan.json');
  writeFileSync(file, JSON.stringify(plan));
  return runCli(['shrink', file]);
}

test('safe plan exits 0 with a certificate', () => {
  const { status, json, stderr } = runCliWithPlan({
    limits: { A: 100 },
    commands: [
      { op: 'post', id: 'p1', account: 'A', amount: 40 },
      { op: 'cancel', postId: 'p1' },
      { op: 'freeze', account: 'A', amount: 10 },
    ],
  });
  assert.equal(status, 0, stderr);
  assert.equal(json.status, 'SAFE');
  assert.equal(json.certificate.commandsChecked, 3);
  assert.match(json.replayHash, /^[0-9a-f]{64}$/);
  assert.equal(json.finalState.accounts.A.postedNet, 0);
});

test('unsafe plan exits 0 with minimal counterexample, final state, replay hash and removed commands', () => {
  const { status, json, stderr } = runCliWithPlan({
    limits: { A: 100 },
    commands: [
      { op: 'post', id: 'p1', account: 'B', amount: 10 },
      { op: 'post', id: 'p2', account: 'B', amount: 20 },
      { op: 'cancel', postId: 'p1' },
      { op: 'freeze', account: 'A', amount: 150 },
      { op: 'freeze', account: 'B', amount: 5 },
    ],
  });
  assert.equal(status, 0, stderr);
  assert.equal(json.status, 'UNSAFE');
  assert.deepEqual(json.counterexample, [{ op: 'freeze', account: 'A', amount: 150 }]);
  assert.equal(json.removed.length, 4);
  assert.deepEqual(json.removed.map((r) => r.index), [0, 1, 2, 4]);
  assert.equal(json.finalState.accounts.A.available, -50);
  assert.match(json.replayHash, /^[0-9a-f]{64}$/);
  assert.equal(json.violations[0].invariant, 'NET_PLUS_FROZEN_WITHIN_LIMIT');
});

test('negative amount exits 1 with INVALID_COMMAND', () => {
  const { status, stderr } = runCliWithPlan({
    limits: {},
    commands: [{ op: 'post', id: 'p1', account: 'A', amount: -3 }],
  });
  assert.equal(status, 1);
  assert.match(stderr, /INVALID_COMMAND/);
});

test('illegal id exits 1 with INVALID_COMMAND', () => {
  const { status, stderr } = runCliWithPlan({
    limits: {},
    commands: [{ op: 'cancel', postId: 'ghost' }],
  });
  assert.equal(status, 1);
  assert.match(stderr, /INVALID_COMMAND/);
});

test('cyclic correction exits 1 with INVALID_COMMAND', () => {
  const { status, stderr } = runCliWithPlan({
    limits: {},
    commands: [
      { op: 'post', id: 'p1', account: 'A', amount: 1 },
      { op: 'cancel', postId: 'p1' },
      { op: 'cancel', postId: 'p1' },
    ],
  });
  assert.equal(status, 1);
  assert.match(stderr, /INVALID_COMMAND/);
  assert.match(stderr, /cyclic correction/);
});

test('missing arguments exit 2 with usage', () => {
  const { status, stderr } = runCli([]);
  assert.equal(status, 2);
  assert.match(stderr, /USAGE/);
});
