'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runCli } = require('../cli');

const FIX = (name) => path.join(__dirname, 'fixtures', name);

// Note: the sandbox here forbids child processes, so the CLI is exercised
// in-process through runCli with captured streams (same code path as
// `node cli.js ...`, which is verified manually in README).
function cli(argv) {
  let out = '';
  let err = '';
  const status = runCli(argv, { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
  return { status, json: out ? JSON.parse(out) : null, stderr: err };
}

test('CLI happy path exits 0 and prints life curve, alarms, rejections', () => {
  const { status, json } = cli([path.join(__dirname, '..', 'examples', 'ops.json'), '--limit', '80', '--max', '3']);
  assert.equal(status, 0);
  assert.equal(json.exitCode, 0);
  assert.ok(json.curve.length > 0);
  assert.ok(json.alarms.some((a) => a.kind === 'LIMIT_REACHED' && a.wear === 82));
  assert.equal(json.rejections.length, 1);
  assert.equal(json.rejections[0].reason, 'PENDING_CHANGE');
  assert.equal(json.budgetUsed, 2);
  assert.equal(json.activeTool, 'T2');
  assert.equal(json.wear, 0);
  assert.ok(json.evidence.some((e) => e.kind === 'DUPLICATE'));
  assert.ok(json.evidence.some((e) => e.kind === 'OUT_OF_ORDER'));
});

test('CLI exits 5 on budget exhaustion', () => {
  const { status, json } = cli([FIX('budget.json'), '--limit', '80', '--max', '1']);
  assert.equal(status, 5);
  assert.equal(json.exitCode, 5);
  assert.equal(json.rejections[0].reason, 'BUDGET_EXCEEDED');
  assert.equal(json.activeTool, 'T2'); // second CHANGE not half-committed
  assert.equal(json.budgetUsed, 1);
});

test('CLI exits 11 on monotonic violation', () => {
  const { status, json } = cli([FIX('monotonic.json'), '--limit', '80', '--max', '3']);
  assert.equal(status, 11);
  assert.equal(json.violation.reported, 40);
});

test('CLI exits 2 on bad usage', () => {
  const { status, stderr } = cli([]);
  assert.equal(status, 2);
  assert.match(stderr, /usage:/);
});
