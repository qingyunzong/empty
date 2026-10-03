import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-cli-'));
  const store = join(dir, 'store.jsonl');
  const runCli = (...args) => {
    const out = { stdout: '', stderr: '' };
    const status = run(['--store', store, ...args], {
      log: (s) => { out.stdout += s + '\n'; },
      error: (s) => { out.stderr += s + '\n'; },
    });
    return { status, stdout: out.stdout.trim(), stderr: out.stderr.trim() };
  };
  return { dir, store, run: runCli };
}

test('CLI happy path: case, add, search, cert, revoke, amounts', () => {
  const { dir, run } = makeSandbox();
  try {
    let r = run('case:create', 'CB-1');
    assert.equal(r.status, 0, r.stderr);

    r = run('add', 'CB-1', 'ev-1', '120', '1', 'merchant promised refund then vanished');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).revision, 1);

    r = run('add', 'CB-1', 'ev-1', '130', '2', 'issuer confirmed chargeback fraud');
    assert.equal(r.status, 0, r.stderr);

    r = run('search', 'CB-1', '--phrase', 'confirmed', 'chargeback');
    assert.equal(r.status, 0, r.stderr);
    let hits = JSON.parse(r.stdout);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].revision, 2);

    // historical view
    r = run('search', 'CB-1', '--phrase', 'promised', 'refund', '--revision', '1');
    assert.equal(JSON.parse(r.stdout).length, 1);

    // near query, unordered
    r = run('search', 'CB-1', '--near', 'chargeback', 'issuer', '--slop', '2');
    hits = JSON.parse(r.stdout);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].distance, 2);

    r = run('cert', 'CB-1', '--near', 'chargeback', 'issuer', '--slop', '2');
    const cert = JSON.parse(r.stdout);
    assert.equal(cert.caseId, 'CB-1');
    assert.equal(cert.revision, 2);
    assert.equal(cert.currentAmount, 130);
    assert.equal(cert.reversalAmount, 0);
    assert.match(cert.recordSetHash, /^[0-9a-f]{64}$/);

    r = run('revoke', 'CB-1', 'ev-1', '2');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).reversalAmount, -130);

    r = run('amounts', 'CB-1');
    const amounts = JSON.parse(r.stdout);
    assert.equal(amounts.currentAmount, 120, 'falls back to non-revoked revision 1');
    assert.equal(amounts.reversalAmount, -130);

    // current search no longer matches revoked revision text
    r = run('search', 'CB-1', '--phrase', 'confirmed', 'chargeback');
    assert.equal(JSON.parse(r.stdout).length, 0);
    // history still does
    r = run('search', 'CB-1', '--phrase', 'confirmed', 'chargeback', '--revision', '2');
    assert.equal(JSON.parse(r.stdout).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI errors exit non-zero and append nothing to the log', () => {
  const { dir, store, run } = makeSandbox();
  try {
    assert.equal(run('case:create', 'CB-1').status, 0);
    assert.equal(run('add', 'CB-1', 'ev-1', '10', '1', 'alpha').status, 0);
    const sizeBefore = readFileSync(store, 'utf8');

    let r = run('add', 'CB-UNKNOWN', 'ev-2', '5', '1', 'beta');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERR_UNKNOWN_CASE/);

    r = run('add', 'CB-1', 'ev-1', '5', '1', 'beta');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERR_REVISION_REGRESSION/);

    r = run('revoke', 'CB-1', 'ev-1', '9');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERR_UNKNOWN_REVISION/);

    assert.equal(readFileSync(store, 'utf8'), sizeBefore, 'failed ops appended nothing');

    assert.equal(run('revoke', 'CB-1', 'ev-1', '1').status, 0);
    const sizeAfterRevoke = readFileSync(store, 'utf8');
    r = run('revoke', 'CB-1', 'ev-1', '1');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERR_ALREADY_REVOKED/);

    assert.equal(readFileSync(store, 'utf8'), sizeAfterRevoke, 'failed revoke appended nothing');
    assert.ok(sizeAfterRevoke.length > sizeBefore.length, 'successful revoke did append');
    const lines = sizeAfterRevoke.trim().split('\n');
    assert.equal(lines.length, 3, 'case + add + revoke + nothing else');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI usage errors exit non-zero', () => {
  const { dir, run } = makeSandbox();
  try {
    assert.equal(run().status, 1);
    assert.equal(run('bogus-command').status, 1);
    const r = run('search', 'CB-1');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERR_USAGE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
