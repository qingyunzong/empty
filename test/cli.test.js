'use strict';

// CLI tests drive cli.main in-process (the offline sandbox forbids spawning
// child processes); the real `node cli.js ...` invocation is verified in
// RESULTS.md via the shell.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../cli');

function run(args) {
  const io = { stdout: [], stderr: [] };
  const code = main(['node', 'cli.js', ...args], {
    stdout: (s) => io.stdout.push(s),
    stderr: (s) => io.stderr.push(s),
  });
  return { code, stdout: io.stdout.join('\n'), stderr: io.stderr.join('\n') };
}

function withLog(lines, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')), 'hist.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  try {
    return fn(file);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

const LOG = [
  '{"ts":1,"seq":0,"op":"rule","id":"R1","when":{"key":"marginRatio","op":"lt","value":1.3}}',
  '{"ts":10,"seq":2,"op":"set","key":"marginRatio","value":1.5}',
  '{"ts":10,"seq":3,"op":"set","key":"marginRatio","value":1.2}',
];

test('CLI: node cli.js hist.jsonl --as-of 10:3 prints the decision as JSON', () => {
  withLog(LOG, (file) => {
    const at2 = run([file, '--as-of', '10:2']);
    assert.equal(at2.code, 0, at2.stderr);
    assert.equal(JSON.parse(at2.stdout).frozen, false);
    const at3 = run([file, '--as-of', '10:3']);
    assert.equal(at3.code, 0, at3.stderr);
    const r = JSON.parse(at3.stdout);
    assert.equal(r.frozen, true);
    assert.equal(r.rule, 'R1');
    assert.ok(Array.isArray(r.explain) && r.explain.length === 2);
  });
});

test('CLI: --branch selects the branch view', () => {
  withLog([
    LOG[0],
    '{"ts":5,"seq":0,"op":"fork","name":"B"}',
    '{"ts":6,"seq":0,"op":"set","key":"marginRatio","value":1.2,"branch":"B"}',
  ], (file) => {
    assert.equal(JSON.parse(run([file, '--as-of', '7:0']).stdout).frozen, false);
    assert.equal(JSON.parse(run([file, '--as-of', '7:0', '--branch', 'B']).stdout).frozen, true);
  });
});

test('CLI: E_TIME and E_FORK exit with code 1', () => {
  withLog([
    '{"ts":10,"seq":1,"op":"set","key":"x","value":1}',
    '{"ts":9,"seq":0,"op":"set","key":"x","value":2}',
  ], (file) => {
    const r = run([file, '--as-of', '10:1']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /E_TIME/);
  });
  withLog(['{"ts":1,"seq":0,"op":"merge","name":"ghost"}'], (file) => {
    const r = run([file, '--as-of', '1:0']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /E_FORK/);
  });
});

test('CLI: usage problems exit with code 2', () => {
  assert.equal(run([]).code, 2);
  withLog(LOG, (file) => {
    assert.equal(run([file, '--as-of', 'ten']).code, 2);
  });
});
