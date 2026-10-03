import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

function tmpFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'limit-cli-'));
  const file = join(dir, 'ops.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// Invoke the CLI in-process (the sandbox forbids spawning node from node),
// capturing stdout/stderr and the exit code.
function run(args) {
  const out = { stdout: '', stderr: '' };
  const status = runCli(args, {
    stdout: (text) => { out.stdout += text; },
    stderr: (text) => { out.stderr += text; },
  });
  return { status, ...out };
}

test('CLI run: success exits 0 and prints final state', () => {
  const file = tmpFile([
    JSON.stringify({ op: 'open', acc: 'a', creditLimit: 1000 }),
    JSON.stringify({ op: 'freeze', authId: 'au1', acc: 'a', amount: 500, ttl: 10000, time: 0 }),
    JSON.stringify({ op: 'capture', authId: 'au1', amount: 200, time: 10 }),
    JSON.stringify({ op: 'release', authId: 'au1', time: 20 }),
  ]);
  const res = run(['run', file]);
  assert.equal(res.status, 0, res.stderr);
  const summary = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(summary.ok, true);
  assert.equal(summary.ops, 4);
  assert.equal(summary.state.accounts.a.frozen, 0);
  assert.equal(summary.state.accounts.a.used, 200);
});

test('CLI run --explain: prints a trace line per operation', () => {
  const file = tmpFile([
    JSON.stringify({ op: 'open', acc: 'a', creditLimit: 100 }),
    JSON.stringify({ op: 'freeze', authId: 'au1', acc: 'a', amount: 60, ttl: 100, time: 0 }),
  ]);
  const res = run(['run', file, '--explain']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 3); // 2 trace lines + final summary
  assert.equal(lines[0].line, 1);
  assert.equal(lines[1].state.accounts.a.frozen, 60);
});

test('CLI run: E_LIMIT failure exits non-zero and reports the code', () => {
  const file = tmpFile([
    JSON.stringify({ op: 'open', acc: 'a', creditLimit: 100 }),
    JSON.stringify({ op: 'freeze', authId: 'au1', acc: 'a', amount: 60, ttl: 100, time: 0 }),
    JSON.stringify({ op: 'freeze', authId: 'au2', acc: 'a', amount: 60, ttl: 100, time: 1 }),
  ]);
  const res = run(['run', file]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /E_LIMIT/);
});

test('CLI run: E_EXPIRED at exactly ttl exits non-zero', () => {
  const file = tmpFile([
    JSON.stringify({ op: 'freeze', authId: 'au1', acc: 'a', amount: 50, ttl: 500, time: 1000 }),
    JSON.stringify({ op: 'capture', authId: 'au1', amount: 10, time: 1500 }),
  ]);
  const res = run(['run', file, '--limit', '100']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /E_EXPIRED/);
});

test('CLI run: E_STATE on unknown auth exits non-zero', () => {
  const file = tmpFile([
    JSON.stringify({ op: 'capture', authId: 'ghost', amount: 1, time: 0 }),
  ]);
  const res = run(['run', file, '--limit', '100']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /E_STATE/);
});

test('CLI run: more than 20000 operations is rejected', () => {
  const lines = [JSON.stringify({ op: 'open', acc: 'a', creditLimit: 1 })];
  for (let i = 0; i < 20001; i++) lines.push(JSON.stringify({ op: 'sweep', time: i }));
  const file = tmpFile(lines);
  const res = run(['run', file]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /too many operations/);
});

test('CLI check: linearizable log prints witness and exits 0', () => {
  const file = tmpFile([
    JSON.stringify({ id: 'c', op: 'capture', authId: 'a1', amount: 10, time: 0, start: 0, end: 0, result: 'ok' }),
    JSON.stringify({ id: 'f', op: 'freeze', authId: 'a1', acc: 'x', amount: 50, ttl: 10000, time: 0, start: 0, end: 0, result: 'ok' }),
    JSON.stringify({ id: 'r', op: 'release', authId: 'a1', time: 0, start: 0, end: 0, result: 'ok' }),
  ]);
  const res = run(['check', file, '--limit', '100']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /LINEARIZABLE/);
  const witness = JSON.parse(res.stdout.match(/witness: (\[.*\])/)[1]);
  assert.deepEqual(witness, ['f', 'c', 'r']);
});

test('CLI check: non-linearizable log exits non-zero', () => {
  const file = tmpFile([
    JSON.stringify({ id: 'f1', op: 'freeze', authId: 'a1', acc: 'x', amount: 60, ttl: 10000, time: 0, start: 0, end: 0, result: 'ok' }),
    JSON.stringify({ id: 'f2', op: 'freeze', authId: 'a2', acc: 'x', amount: 60, ttl: 10000, time: 0, start: 0, end: 0, result: 'ok' }),
    JSON.stringify({ id: 'f3', op: 'freeze', authId: 'a3', acc: 'x', amount: 40, ttl: 10000, time: 0, start: 0, end: 0, result: 'ok' }),
  ]);
  const res = run(['check', file, '--limit', '100']);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /NOT_LINEARIZABLE/);
});

test('CLI: usage error exits non-zero', () => {
  const res = run(['bogus']);
  assert.equal(res.status, 2);
});
