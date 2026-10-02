'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { run } = require('../src/cli');

const CLI = join(__dirname, '..', 'bin', 'audit-sample.js');

// In-process CLI harness: captures stdout, feeds stdin/files, returns code.
function runCli(input, args = []) {
  let stdout = '';
  const code = run(['node', 'audit-sample', ...args], {
    readStdin: () => (typeof input === 'string' ? input : JSON.stringify(input)),
    readFile: (path) => {
      const { readFileSync } = require('node:fs');
      return readFileSync(path, 'utf8');
    },
    write: (s) => {
      stdout += s;
    },
  });
  return { code, stdout, json: () => JSON.parse(stdout) };
}

const validInput = {
  seed: 'cli-seed',
  version: 3,
  strata: {
    retail: [
      { source: 'core', seq: 1, version: 1, amount: 10 },
      { source: 'core', seq: 2, version: 1, amount: 20 },
      { source: 'core', seq: 3, version: 1, amount: 30 },
    ],
  },
  quotas: { retail: 2 },
};

test('CLI reads JSON from stdin and writes JSON to stdout, exit 0', () => {
  const r = runCli(validInput);
  assert.equal(r.code, 0);
  const out = r.json();
  assert.equal(out.ok, true);
  assert.equal(out.samples.retail.length, 2);
  assert.match(out.merkleRoot, /^[0-9a-f]{64}$/);
  assert.deepEqual(out.invalidated, []);
  assert.equal(out.quotaUse.retail.used, 2);
});

test('CLI reads JSON from a file argument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-cli-'));
  const file = join(dir, 'input.json');
  writeFileSync(file, JSON.stringify(validInput));
  const r = runCli(undefined, [file]);
  assert.equal(r.code, 0);
  assert.equal(r.json().ok, true);
});

test('CLI is deterministic: same input twice, same bytes', () => {
  assert.equal(runCli(validInput).stdout, runCli(validInput).stdout);
});

test('CLI failure: missing seed exits 2 with SEED_REQUIRED JSON', () => {
  const input = { ...validInput };
  delete input.seed;
  const r = runCli(input);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, 'SEED_REQUIRED');
});

test('CLI failure: quota exceeded exits 2 with QUOTA JSON', () => {
  const r = runCli({ ...validInput, quotas: { retail: 99 } });
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, 'QUOTA');
});

test('CLI failure: missing stratum exits 2 with STRATA_MISSING and the gap list', () => {
  const r = runCli({ ...validInput, quotas: { retail: 1, fx: 1 } });
  assert.equal(r.code, 2);
  const out = r.json();
  assert.equal(out.error.code, 'STRATA_MISSING');
  assert.deepEqual(out.error.details.missing, ['fx']);
});

test('CLI failure: version conflict exits 2 with VERSION_CONFLICT JSON', () => {
  const r = runCli({
    ...validInput,
    strata: {
      retail: [
        { source: 'core', seq: 1, version: 1, amount: 10 },
        { source: 'core', seq: 1, version: 1, amount: 11 },
      ],
    },
    quotas: { retail: 1 },
  });
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, 'VERSION_CONFLICT');
});

test('CLI failure: malformed JSON exits 2', () => {
  const r = runCli('{not json');
  assert.equal(r.code, 2);
  assert.equal(r.json().ok, false);
  assert.equal(r.json().error.code, 'INPUT_INVALID');
});

test('CLI verify mode confirms a genuine result and rejects tampering', () => {
  const result = runCli(validInput).json();

  const okRun = runCli({ verify: true, strata: validInput.strata, quotas: validInput.quotas, result });
  assert.equal(okRun.code, 0);
  assert.equal(okRun.json().ok, true);

  const tampered = JSON.parse(JSON.stringify(result));
  tampered.samples.retail = ['core#9'];
  const badRun = runCli({ verify: true, strata: validInput.strata, quotas: validInput.quotas, result: tampered });
  assert.equal(badRun.code, 2);
  assert.equal(badRun.json().ok, false);
});

test('CLI incremental flow: revoke, resample with prev, old certificate superseded', () => {
  const first = runCli(validInput).json();
  const revoked = {
    ...validInput,
    version: 4,
    strata: {
      retail: [...validInput.strata.retail, { source: 'core', seq: 2, version: 2, revoked: true }],
    },
    prev: first,
  };
  const r = runCli(revoked);
  assert.equal(r.code, 0);
  const out = r.json();
  assert.equal(out.invalidated.length, 1);
  assert.equal(out.invalidated[0].status, 'SUPERSEDED');
  assert.equal(out.invalidated[0].stratum, 'retail');
  assert.ok(!out.samples.retail.includes('core#2'));
  assert.equal(out.quotaUse.retail.population, 2);
});

test('CLI --help exits 0', () => {
  const r = runCli(undefined, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: audit-sample/);
});

// End-to-end test of the real binary via a child process. Skipped when the
// environment forbids spawning (e.g. restricted sandboxes).
test('real binary: stdin JSON -> stdout JSON, exit codes 0 and 2', (t) => {
  const ok = spawnSync(process.execPath, [CLI], {
    input: JSON.stringify(validInput),
    encoding: 'utf8',
    timeout: 5000,
  });
  if ((ok.error && ok.error.code === 'EPERM') || ok.status === null) {
    t.skip('child processes are not permitted in this environment');
    return;
  }
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);

  const bad = spawnSync(process.execPath, [CLI], { input: '{}', encoding: 'utf8', timeout: 5000 });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).error.code, 'SEED_REQUIRED');
});
