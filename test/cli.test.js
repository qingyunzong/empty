'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../src/cli');

// The sandbox forbids spawning child processes from tests, so the CLI entry
// is exercised in-process: main(argv) returns the exit code and writes to
// process.stdout/stderr, which we capture here.
function runCli(argv) {
  const captured = { stdout: '', stderr: '' };
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    captured.stdout += chunk;
    return true;
  };
  process.stderr.write = (chunk) => {
    captured.stderr += chunk;
    return true;
  };
  try {
    const code = main(argv);
    return { code, ...captured };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

const validInput = {
  accounts: [
    { id: 'A', limit: 100 },
    { id: 'B', limit: 100 },
  ],
  instructions: [{ id: 'I1', from: 'A', to: 'B', amount: 40 }],
};

test('CLI settles a valid input and exits 0', () => {
  withTempDir((dir) => {
    const input = writeJson(dir, 'in.json', validInput);
    const output = path.join(dir, 'out.json');
    const result = runCli(['settle', input, output]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /SETTLED/);
    const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(parsed.status, 'SETTLED');
    assert.deepEqual(parsed.dispositions, [{ instruction: 'I1', disposition: 'FULL' }]);
    assert.deepEqual(parsed.freezes, { A: 40, B: 0 });
    assert.ok(parsed.certificate);
    assert.ok(Array.isArray(parsed.certificate.decisions));
    assert.ok(parsed.certificate.domainsAfterPropagation.I1.includes('FULL'));
    assert.equal(typeof parsed.certificate.backtracks, 'number');
  });
});

test('CLI rejects malformed JSON with exit code 1', () => {
  withTempDir((dir) => {
    const input = writeJson(dir, 'in.json', '{ not json');
    const output = path.join(dir, 'out.json');
    const result = runCli(['settle', input, output]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot read or parse/);
    assert.ok(!fs.existsSync(output));
  });
});

test('CLI rejects references to unknown accounts with exit code 1', () => {
  withTempDir((dir) => {
    const input = writeJson(dir, 'in.json', {
      accounts: [{ id: 'A', limit: 10 }],
      instructions: [{ id: 'I1', from: 'A', to: 'GHOST', amount: 1 }],
    });
    const result = runCli(['settle', input, path.join(dir, 'out.json')]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown account/);
  });
});

// Acceptance 4: an illegal revocation fails with exit code 1.
test('CLI rejects illegal revocations with exit code 1', () => {
  withTempDir((dir) => {
    const cases = [
      { seq: 1, instruction: 'NOPE' },
      { seq: 0, instruction: 'I1' },
      { seq: 1.5, instruction: 'I1' },
    ];
    for (const revocation of cases) {
      const input = writeJson(dir, 'in.json', { ...validInput, revocations: [revocation] });
      const result = runCli(['settle', input, path.join(dir, 'out.json')]);
      assert.equal(result.code, 1, JSON.stringify(revocation));
    }
    const duplicate = writeJson(dir, 'in.json', {
      ...validInput,
      revocations: [
        { seq: 1, instruction: 'I1' },
        { seq: 2, instruction: 'I1' },
      ],
    });
    const result = runCli(['settle', duplicate, path.join(dir, 'out.json')]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /duplicate revocation/);
  });
});

test('CLI reports UNSAT with exit code 0', () => {
  withTempDir((dir) => {
    const input = writeJson(dir, 'in.json', {
      accounts: [
        { id: 'A', limit: 10 },
        { id: 'B', limit: 10 },
      ],
      instructions: [{ id: 'I1', from: 'A', to: 'B', amount: 50, mandatory: true }],
    });
    const output = path.join(dir, 'out.json');
    const result = runCli(['settle', input, output]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(parsed.status, 'UNSAT');
    assert.equal(parsed.certificate.conflict.kind, 'LIMIT_EXCEEDED');
  });
});

test('CLI reports PENDING with exit code 0 when the budget is exhausted', () => {
  withTempDir((dir) => {
    const input = writeJson(dir, 'in.json', {
      accounts: [
        { id: 'A', limit: 50 },
        { id: 'B', limit: 200 },
      ],
      instructions: [
        { id: 'I1', from: 'A', to: 'B', amount: 100, mandatory: true },
        { id: 'I2', from: 'B', to: 'A', amount: 60 },
      ],
      budget: 0,
    });
    const output = path.join(dir, 'out.json');
    const result = runCli(['settle', input, output]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(parsed.status, 'PENDING');
    assert.ok(parsed.certificate.conflict);
  });
});

test('CLI rejects bad usage with exit code 1', () => {
  assert.equal(runCli([]).code, 1);
  assert.equal(runCli(['settle']).code, 1);
  assert.equal(runCli(['bogus', 'a', 'b']).code, 1);
});
