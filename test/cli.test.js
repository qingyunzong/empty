'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../cli');

const CLI = path.join(__dirname, '..', 'cli.js');
const SPECS = path.join(__dirname, '..', 'specs');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-')), name);
}

function runCli(args) {
  const stdout = [];
  const stderr = [];
  const status = main(['node', CLI, ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

test('cli writes counterexample.json for violable spec', () => {
  const out = tmpFile('counterexample.json');
  const run = runCli([path.join(SPECS, 'self-approval.json'), out]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(result.result, 'counterexample');
  assert.equal(result.violation.amount, 101);
});

test('cli writes proof.json for denied spec', () => {
  const out = tmpFile('proof.json');
  const run = runCli([path.join(SPECS, 'self-approval-deny.json'), out]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(result.result, 'proof');
  assert.equal(result.coverage.combinations, 20);
});

test('cli exits 1 with E_PARSE on malformed JSON', () => {
  const bad = tmpFile('bad.json');
  fs.writeFileSync(bad, '{ not valid json');
  const run = runCli([bad, tmpFile('out.json')]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /E_PARSE/);
});

test('cli exits 1 with E_PARSE on schema violations', () => {
  const bad = tmpFile('bad-schema.json');
  fs.writeFileSync(bad, JSON.stringify({ subjects: [], policy: { rules: [] } }));
  const run = runCli([bad, tmpFile('out.json')]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /E_PARSE/);
});

test('cli exits 1 with E_PARSE when spec file is missing', () => {
  const run = runCli([tmpFile('does-not-exist.json'), tmpFile('out.json')]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /E_PARSE/);
});

test('cli exits 2 on wrong argument count', () => {
  const run = runCli([]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage/);
});
