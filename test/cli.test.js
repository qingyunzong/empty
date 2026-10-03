'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chargeback-cli-'));
}

function runCli(argv) {
  const errors = [];
  const code = run(argv, { stderr: (msg) => errors.push(msg) });
  return { code, stderr: errors.join('\n') };
}

const DEMO_CASE = [
  '{"op":"add_node","id":"m1","balance":100,"rule":"self"}',
  '{"op":"add_node","id":"s1","parent":"m1","balance":40,"rule":"self"}',
  '{"op":"add_node","id":"t1","parent":"s1","balance":30,"rule":"self"}',
  '{"op":"chargeback","id":"cb1","node":"t1","amount":90}',
  '{"op":"adjust","node":"s1","delta":15}',
  '{"op":"reverse","chargeback":"cb1"}',
  '{"op":"adjust","node":"s1","delta":-15}',
  '{"op":"reverse","chargeback":"cb1"}',
  '{"op":"enumerate","amount":50}',
].join('\n');

test('cli processes a JSONL case file and writes result.json', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'case.jsonl');
  const output = path.join(dir, 'result.json');
  fs.writeFileSync(input, DEMO_CASE);

  const run1 = runCli(['node', 'cli.js', input, output]);
  assert.equal(run1.code, 0);
  assert.equal(run1.stderr, '');
  const results = JSON.parse(fs.readFileSync(output, 'utf8'));

  assert.equal(results.length, 9);
  const cb = results[3];
  assert.equal(cb.op, 'chargeback');
  assert.equal(cb.status, 'settled');
  assert.deepEqual(
    cb.steps.map((s) => [s.node, s.amount]),
    [['t1', 30], ['s1', 40], ['m1', 20]],
  );

  const failedRestore = results[5];
  assert.equal(failedRestore.ok, false);
  assert.equal(failedRestore.code, 'E_RESTORE');
  assert.equal(failedRestore.failedNode, 's1');

  const okRestore = results[7];
  assert.equal(okRestore.ok, true);
  assert.deepEqual(
    okRestore.restored.map((s) => [s.node, s.amount]),
    [['m1', 20], ['s1', 40], ['t1', 30]],
  );

  const enumeration = results[8];
  assert.equal(enumeration.op, 'enumerate');
  assert.deepEqual(
    enumeration.paths.map((p) => p.node),
    ['m1', 's1', 't1'],
  );
});

test('cli exits 1 and writes to stderr on invalid JSON', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'bad.jsonl');
  const output = path.join(dir, 'result.json');
  fs.writeFileSync(input, '{"op":"add_node","id":"a"}\n{broken');

  const res = runCli(['node', 'cli.js', input, output]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /E_PARSE/);
  assert.match(res.stderr, /line 2/);
  assert.equal(fs.existsSync(output), false);
});

test('cli exits 1 and writes to stderr on semantic errors', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'case.jsonl');
  const output = path.join(dir, 'result.json');
  fs.writeFileSync(input, '{"op":"chargeback","id":"cb1","node":"ghost","amount":10}');

  const res = runCli(['node', 'cli.js', input, output]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /E_UNKNOWN_NODE/);
  assert.equal(fs.existsSync(output), false);
});

test('cli exits 1 on missing input file and on wrong usage', () => {
  const dir = tmpdir();
  const missing = runCli(['node', 'cli.js', path.join(dir, 'nope.jsonl'), path.join(dir, 'out.json')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /E_IO/);

  const usage = runCli(['node', 'cli.js']);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /usage:/);
});
