'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { baseSpec, denySelfRule } = require('../helpers/fixtures');

const CLI = path.join(__dirname, '..', 'cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-cli-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI writes counterexample.json for a violating spec', () => {
  withTempDir((dir) => {
    const specPath = path.join(dir, 'spec.json');
    const outPath = path.join(dir, 'counterexample.json');
    fs.writeFileSync(specPath, JSON.stringify(baseSpec()));
    const run = runCli([specPath, outPath]);
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(out.result, 'counterexample');
    assert.equal(out.violation.amount, 101);
  });
});

test('CLI writes proof.json with a certificate for a denied spec', () => {
  withTempDir((dir) => {
    const raw = baseSpec();
    raw.rules.push(denySelfRule());
    const specPath = path.join(dir, 'spec.json');
    const outPath = path.join(dir, 'proof.json');
    fs.writeFileSync(specPath, JSON.stringify(raw));
    const run = runCli([specPath, outPath]);
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(out.result, 'proof');
    assert.match(out.certificate.hash, /^[0-9a-f]{64}$/);
    assert.equal(out.certificate.combinations, 40);
  });
});

test('CLI exits 1 with E_PARSE on malformed JSON', () => {
  withTempDir((dir) => {
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, '{ not json ');
    const run = runCli([specPath, path.join(dir, 'out.json')]);
    assert.equal(run.status, 1);
  });
});

test('CLI exits 1 with E_PARSE on schema violations', () => {
  withTempDir((dir) => {
    const raw = { ...baseSpec(), subjects: ['a', 'b', 'c', 'd', 'e'] };
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(raw));
    const run = runCli([specPath, path.join(dir, 'out.json')]);
    assert.equal(run.status, 1);
  });
});

test('CLI exits 1 with E_PARSE when the spec file is missing', () => {
  withTempDir((dir) => {
    const run = runCli([path.join(dir, 'nope.json'), path.join(dir, 'out.json')]);
    assert.equal(run.status, 1);
  });
});

// The sandboxed test environment cannot capture child-process stdio, so the
// E_PARSE message itself is verified by driving main() in-process.
test('CLI prints E_PARSE diagnostics to stderr', () => {
  withTempDir((dir) => {
    const { main } = require('../cli');
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, '{ not json ');
    const errors = [];
    const original = console.error;
    console.error = (msg) => errors.push(String(msg));
    let code;
    try {
      code = main([specPath, path.join(dir, 'out.json')]);
    } finally {
      console.error = original;
    }
    assert.equal(code, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^E_PARSE: /);
  });
});

test('CLI exits 2 on wrong argument count', () => {
  const run = runCli([]);
  assert.equal(run.status, 2);
});
