import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

// NOTE: the sandbox blocks child_process spawning (EPERM), so the CLI is
// exercised in-process through runCli(), which bin/evidence.js wraps 1:1.

function runOk(args) {
  const res = runCli(args);
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  assert.equal(res.stderr, '');
  return JSON.parse(res.stdout);
}

test('CLI: add / query / correct / revoke / certificate lifecycle', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'evidence-')), 'db.json');
  const base = ['--db', db];

  runOk(['add', ...base, '--id', 'E1', '--case', 'C1', '--amount', '100', '--text', 'stolen card used at hotel']);
  runOk(['add', ...base, '--id', 'E2', '--case', 'C1', '--amount', '250', '--text', 'card not present transaction']);

  let out = runOk(['query', ...base, '--case', 'C1', '--phrase', 'stolen card']);
  assert.equal(out.hits.length, 1);

  out = runOk(['query', ...base, '--case', 'C1', '--near', 'card transaction', '--slop', '3']);
  assert.deepEqual(out.hits.map((h) => h.evidenceId), ['E2']);

  runOk(['correct', ...base, '--id', 'E1', '--text', 'cardholder verified the hotel stay', '--revision', '2']);
  out = runOk(['query', ...base, '--case', 'C1', '--phrase', 'stolen card']);
  assert.equal(out.hits.length, 0, 'current view uses corrected text');
  out = runOk(['query', ...base, '--case', 'C1', '--phrase', 'stolen card', '--at-revision', '1']);
  assert.equal(out.hits.length, 1, 'history still queryable');

  const tomb = runOk(['revoke', ...base, '--id', 'E2', '--revision', '1']);
  assert.equal(tomb.reversalAmount, -250);

  const cert = runOk(['certificate', ...base, '--case', 'C1', '--near', 'cardholder verified', '--slop', '1']);
  assert.equal(cert.caseId, 'C1');
  assert.equal(cert.revision, 2);
  assert.equal(cert.reversalAmount, -250);
  assert.equal(cert.currentAmount, 100);
  assert.match(cert.recordSetHash, /^[0-9a-f]{64}$/);
  assert.equal(cert.hits.length, 1);
  assert.ok(Array.isArray(cert.hits[0].positions));

  const amount = runOk(['amount', ...base, '--case', 'C1']);
  assert.deepEqual(amount, { caseId: 'C1', currentAmount: 100, reversalAmount: -250 });
});

test('CLI: error paths exit 1 and do not write', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'evidence-')), 'db.json');
  const base = ['--db', db];
  runOk(['add', ...base, '--id', 'E1', '--case', 'C1', '--amount', '100', '--text', 'stolen card']);
  const before = readFileSync(db, 'utf8');

  // unknown case
  let res = runCli(['certificate', ...base, '--case', 'NOPE', '--phrase', 'x']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /UNKNOWN_CASE/);

  // revision regression
  res = runCli(['correct', ...base, '--id', 'E1', '--text', 'y', '--revision', '1']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /REVISION_REGRESSION/);
  assert.equal(readFileSync(db, 'utf8'), before, 'failed correct wrote nothing');

  // double revoke
  runOk(['revoke', ...base, '--id', 'E1', '--revision', '1']);
  const afterRevoke = readFileSync(db, 'utf8');
  res = runCli(['revoke', ...base, '--id', 'E1', '--revision', '1']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /ALREADY_REVOKED/);
  assert.equal(readFileSync(db, 'utf8'), afterRevoke, 'failed revoke wrote nothing');
  assert.ok(before.length > 0 && existsSync(db));
});
