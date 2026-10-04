import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../cli.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'settle-cli-'));

test('CLI emits JSONL diffs with proof for each op', () => {
  const input = [
    JSON.stringify({ op: 'add_contract', id: 'C1', type: 'loan', freq: 'monthly', start: '2024-01-31', end: '2024-03-31', amount: 50 }),
    JSON.stringify({ op: 'add_holiday', date: '2024-02-29' }),
    JSON.stringify({ op: 'revoke_contract', id: 'C1' }),
  ].join('\n') + '\n';
  const res = run(['--data', tmp()], input);
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0].diff.added, ['C1#0', 'C1#1', 'C1#2']);
  assert.match(lines[0].proof.hash, /^[0-9a-f]{64}$/);
  // holiday on Feb 29 pushes C1#1 to Mar 1
  assert.deepEqual(lines[1].diff.updated, [{ id: 'C1#1', from: '2024-02-29', to: '2024-03-01' }]);
  assert.deepEqual(lines[2].diff.removed, ['C1#0', 'C1#1', 'C1#2']);
});

test('CLI: BAD_RANGE goes to stderr with exit code 10', () => {
  const input = JSON.stringify({ op: 'add_contract', id: 'C1', freq: 'monthly', start: '2024-05-01', end: '2024-04-01' }) + '\n';
  const res = run(['--data', tmp()], input);
  assert.equal(res.code, 10);
  const err = JSON.parse(res.stderr.trim().split('\n').pop());
  assert.equal(err.error, 'BAD_RANGE');
  assert.equal(res.stdout, '');
});

test('CLI: malformed JSON line exits 10 with BAD_JSON', () => {
  const res = run(['--data', tmp()], '{not json}\n');
  assert.equal(res.code, 10);
  assert.match(res.stderr, /BAD_JSON/);
});

test('CLI: state persists across invocations via --data dir', () => {
  const dir = tmp();
  const r1 = run(['--data', dir], JSON.stringify({ op: 'add_contract', id: 'C1', freq: 'monthly', start: '2024-01-31', end: '2024-02-29' }) + '\n');
  assert.equal(r1.code, 0);
  const r2 = run(['--data', dir], JSON.stringify({ op: 'revoke_contract', id: 'C1' }) + '\n');
  assert.equal(r2.code, 0);
  const line = JSON.parse(r2.stdout.trim());
  assert.deepEqual(line.diff.removed, ['C1#0', 'C1#1']);
});
