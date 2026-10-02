'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

function tmpLog(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')), 'hist.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('CLI: hist.jsonl --as-of 10:3 prints JSON verdict, exit 0', () => {
  const file = tmpLog([
    { ts: 10, seq: 1, op: 'rule', id: 'R1' },
    { ts: 10, seq: 2, op: 'trigger', rule: 'R1' },
    { ts: 10, seq: 4, op: 'revoke', rule: 'R1' },
  ]);
  const res = run([file, '--as-of', '10:3']);
  assert.equal(res.code, 0, res.stderr);
  const verdict = JSON.parse(res.stdout);
  assert.equal(verdict.frozen, true);
  assert.equal(verdict.rule, 'R1');
  assert.equal(verdict.asOf, '10:3');
  assert.deepEqual(verdict.explanation.map((e) => e.op), ['rule', 'trigger']);

  const after = run([file, '--as-of', '10:4']);
  assert.equal(JSON.parse(after.stdout).frozen, false);
});

test('CLI: --branch selects the branch view', () => {
  const file = tmpLog([
    { ts: 1, seq: 1, op: 'rule', id: 'R1' },
    { ts: 2, seq: 1, op: 'fork', branch: 'main', branches: ['b1'] },
    { ts: 3, seq: 1, op: 'trigger', rule: 'R1', branch: 'b1' },
  ]);
  assert.equal(JSON.parse(run([file, '--as-of', '4:0']).stdout).frozen, false);
  assert.equal(JSON.parse(run([file, '--as-of', '4:0', '--branch', 'b1']).stdout).frozen, true);
});

test('CLI: --as-of=ts:seq inline form works', () => {
  const file = tmpLog([
    { ts: 1, seq: 1, op: 'rule', id: 'R1' },
    { ts: 2, seq: 1, op: 'trigger', rule: 'R1' },
  ]);
  const res = run([file, '--as-of=3:0']);
  assert.equal(res.code, 0);
  assert.equal(JSON.parse(res.stdout).frozen, true);
});

test('CLI: E_TIME exits 1', () => {
  const file = tmpLog([{ ts: 1, seq: 1, op: 'rule', id: 'R1' }]);
  const badAsOf = run([file, '--as-of', 'not-a-time']);
  assert.equal(badAsOf.code, 1);
  assert.match(badAsOf.stderr, /^E_TIME:/);

  const missing = run([file]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^E_TIME:/);

  const badEvent = tmpLog([{ ts: 'x', seq: 1, op: 'rule', id: 'R1' }]);
  const res = run([badEvent, '--as-of', '1:1']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /^E_TIME:/);
});

test('CLI: E_FORK exits 1', () => {
  const file = tmpLog([
    { ts: 1, seq: 1, op: 'fork', branch: 'main', branches: ['b1'] },
    { ts: 2, seq: 1, op: 'merge', branch: 'main', sources: ['ghost'] },
  ]);
  const res = run([file, '--as-of', '3:0']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /^E_FORK:/);

  const unknownQueryBranch = run([file, '--as-of', '1:1', '--branch', 'ghost']);
  assert.equal(unknownQueryBranch.code, 1);
  assert.match(unknownQueryBranch.stderr, /^E_FORK:/);
});

test('CLI: unreadable file and bad usage exit 1', () => {
  const res = run(['/nonexistent/hist.jsonl', '--as-of', '1:1']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /^E_IO:/);

  const noFile = run(['--as-of', '1:1']);
  assert.equal(noFile.code, 1);
  assert.match(noFile.stderr, /^E_USAGE:/);
});
