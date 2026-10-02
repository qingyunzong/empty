'use strict';

// End-to-end CLI tests: JSON output shape, exit code 2 with positions for
// regex syntax errors, unknown rule ids and out-of-bounds undo; empty
// alphabet is legal.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli: cli } = require('../cli');

const ROOT = path.join(__dirname, '..');

function run(rulesText, planText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-'));
  const rulesPath = path.join(dir, 'rules.jsonl');
  const planPath = path.join(dir, 'plan.txt');
  fs.writeFileSync(rulesPath, rulesText);
  fs.writeFileSync(planPath, planText);
  let stdout = '';
  let stderr = '';
  const status = cli([rulesPath, planPath], {
    out: (s) => { stdout += s; },
    err: (s) => { stderr += s; },
  });
  return { status, stdout, stderr, rulesPath };
}

test('happy path: rejected with shortest witness and snapshot hash', () => {
  const rules = [
    { op: 'add', id: 'r1', kind: 'red', pattern: 'FF' },
    { op: 'add', id: 'y1', kind: 'yellow', pattern: 'SA' },
  ].map(JSON.stringify).join('\n');
  const res = run(rules, 'SAFF\n');
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'rejected');
  assert.deepEqual(out.matchedRuleIds, ['r1', 'y1']);
  assert.equal(out.witness, 'FF');
  assert.match(out.snapshotHash, /^[0-9a-f]{64}$/);
});

test('undo/redo in the log produce a consistent final snapshot', () => {
  const rules = [
    { op: 'add', id: 'r1', kind: 'red', pattern: 'FF' },
    { op: 'add', id: 'r2', kind: 'red', pattern: 'SA' },
    { op: 'undo' },
    { op: 'add', id: 'y1', kind: 'yellow', pattern: 'SA' },
  ].map(JSON.stringify).join('\n');
  const res = run(rules, 'SA');
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  // r2 was undone, so SA is only yellow now.
  assert.equal(out.status, 'needs-confirmation');
  assert.deepEqual(out.matchedRuleIds, ['y1']);
});

test('regex syntax error: exit 2, stderr carries line and column', () => {
  const rules = [
    JSON.stringify({ op: 'add', id: 'ok', kind: 'red', pattern: 'AB' }),
    JSON.stringify({ op: 'add', id: 'bad', kind: 'red', pattern: 'A(B' }),
  ].join('\n');
  const res = run(rules, 'AB');
  assert.equal(res.status, 2);
  assert.match(res.stderr, /rules\.jsonl:2:4: regex syntax error/);
});

test('unknown rule id: exit 2 with line number', () => {
  const rules = [
    JSON.stringify({ op: 'add', id: 'r1', kind: 'red', pattern: 'AB' }),
    JSON.stringify({ op: 'del', id: 'ghost' }),
  ].join('\n');
  const res = run(rules, 'AB');
  assert.equal(res.status, 2);
  assert.match(res.stderr, /rules\.jsonl:2: unknown rule id 'ghost'/);
});

test('undo out of bounds: exit 2 with line number', () => {
  const rules = [
    JSON.stringify({ op: 'add', id: 'r1', kind: 'red', pattern: 'AB' }),
    JSON.stringify({ op: 'undo', k: 5 }),
  ].join('\n');
  const res = run(rules, 'AB');
  assert.equal(res.status, 2);
  assert.match(res.stderr, /rules\.jsonl:2: undo out of bounds/);
});

test('empty alphabet is legal: empty rules log, empty plan', () => {
  const res = run('\n', '\n');
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'feasible');
  assert.deepEqual(out.matchedRuleIds, []);
  assert.equal(out.witness, null);
});

test('batch add is atomic: a bad rule rejects the whole layer', () => {
  const rules = [
    JSON.stringify({ op: 'add', id: 'r1', kind: 'red', pattern: 'AB' }),
    JSON.stringify({
      op: 'add',
      rules: [
        { id: 'n1', kind: 'yellow', pattern: 'S' },
        { id: 'n2', kind: 'red', pattern: 'A(' },
      ],
    }),
  ].join('\n');
  const res = run(rules, 'S');
  assert.equal(res.status, 2);
  assert.match(res.stderr, /rules\.jsonl:2:\d+: regex syntax error/);
});

test('invalid JSON line: exit 2 with line number', () => {
  const res = run('{not json}\n', 'AB');
  assert.equal(res.status, 2);
  assert.match(res.stderr, /rules\.jsonl:1: invalid JSON/);
});
