'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('../testlib/helpers');

const CLI = path.join(__dirname, '..', 'cli.js');

// Note: piped stdio is not reliably captured from spawned children in every
// sandbox, so output is redirected through files instead.
function run(dir, args) {
  const outFile = path.join(dir, 'last.out');
  const errFile = path.join(dir, 'last.err');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  try {
    const result = spawnSync(process.execPath, [CLI, ...args, '--dir', dir], {
      stdio: ['ignore', outFd, errFd],
    });
    return {
      status: result.status,
      stdout: fs.readFileSync(outFile, 'utf8'),
      stderr: fs.readFileSync(errFile, 'utf8'),
    };
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

test('CLI exit codes: 0 success, 1 business failure, 2 usage error', () => {
  const dir = tmpdir();

  assert.equal(run(dir, ['account', 'A', '100']).status, 0);
  assert.equal(run(dir, ['account', 'A', '100']).status, 0, 'account creation is idempotent');
  assert.equal(run(dir, ['account', 'A', '200']).status, 2, 'conflicting budget is a usage error');

  assert.equal(run(dir, ['enqueue', 'A', 'p1', '50']).status, 0);
  assert.equal(run(dir, ['enqueue', 'A', 'p1', '50']).status, 0, 'enqueue is idempotent');
  assert.equal(run(dir, ['enqueue', 'A', 'p1', '60']).status, 2, 'conflicting enqueue is a usage error');
  assert.equal(run(dir, ['enqueue', 'B', 'p2', '10']).status, 1, 'unknown account fails');
  assert.equal(run(dir, ['enqueue', 'A', 'p3', 'abc']).status, 2, 'bad amount is a usage error');

  assert.equal(run(dir, ['freeze', 'missing']).status, 1);
  assert.equal(run(dir, ['freeze']).status, 2, 'missing argument is a usage error');

  assert.equal(run(dir, ['settle']).status, 0);
  assert.equal(run(dir, ['cancel', 'p1']).status, 1, 'settled payments cannot be cancelled');
  assert.equal(run(dir, ['refund', 'p1']).status, 0);
  assert.equal(run(dir, ['refund', 'p1']).status, 1, 'double refund fails');

  assert.equal(run(dir, ['verify']).status, 0);
  assert.equal(run(dir, ['recover']).status, 0);
  assert.equal(run(dir, ['batch']).status, 0);
  assert.equal(run(dir, ['batch', '1']).status, 0);
  assert.equal(run(dir, ['batch', '99']).status, 1);
  assert.equal(run(dir, ['batch', 'next']).status, 0);

  assert.equal(run(dir, ['bogus']).status, 2);
  assert.equal(run(dir, []).status, 2);
});

test('CLI freeze of an over-budget payment fails with exit 1', () => {
  const dir = tmpdir();
  assert.equal(run(dir, ['account', 'A', '10']).status, 0);
  assert.equal(run(dir, ['enqueue', 'A', 'p1', '50']).status, 0);
  const result = run(dir, ['freeze', 'p1']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /insufficient available budget/);
});

test('CLI batch output is decodable json', () => {
  const dir = tmpdir();
  assert.equal(run(dir, ['account', 'A', '100']).status, 0);
  assert.equal(run(dir, ['enqueue', 'A', 'p1', '40']).status, 0);
  assert.equal(run(dir, ['settle']).status, 0);
  const shown = run(dir, ['batch', '1']);
  assert.equal(shown.status, 0);
  const body = JSON.parse(shown.stdout);
  assert.equal(body.seq, 1);
  assert.equal(body.type, 'settle');
  assert.deepEqual(body.selected.map((s) => s.id), ['p1']);
});
