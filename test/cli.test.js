import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runSession, parseSession } from '../src/session.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

const SESSION = [
  { op: 'invoice', id: 'I1', vars: ['amount'], constraints: [{ coefs: [1], op: '==', rhsNum: 100, rhsDen: 1 }] },
  { op: 'credit', refId: 'I1', constraints: [{ coefs: [1], op: '==', rhsNum: 100, rhsDen: 1 }] },
  { op: 'check', invoiceId: 'I1' },
  { op: 'voidCredit', id: 'C1' },
];

test('CLI session: SAT, then E_PINNED on voiding the referenced credit', () => {
  const { results, failed } = runSession(SESSION);
  assert.equal(results[0].status, 'OK');
  assert.equal(results[1].status, 'OK');
  assert.equal(results[2].status, 'SAT');
  assert.deepEqual(results[2].witness, { amount: '100' });
  assert.equal(results[3].error, 'E_PINNED');
  assert.equal(failed, true);
});

test('CLI session: one-cent-short credit yields E_UNSAT with a verifiable certificate', () => {
  const ops = [
    { op: 'invoice', id: 'I2', vars: ['amount'], constraints: [{ coefs: [1], op: '==', rhsNum: 100, rhsDen: 1 }] },
    { op: 'credit', refId: 'I2', constraints: [{ coefs: [1], op: '==', rhsNum: 9999, rhsDen: 100 }] },
    { op: 'check', invoiceId: 'I2' },
  ];
  const first = runSession(ops);
  assert.equal(first.results[2].status, 'UNSAT');
  assert.equal(first.results[2].error, 'E_UNSAT');
  assert.equal(first.failed, true);
  const certificate = first.results[2].certificate;
  const second = runSession([...ops, { op: 'verify', certificate }]);
  assert.equal(second.results[3].valid, true);
});

test('CLI session: E_REF and E_DIM surface as JSON errors', () => {
  const { results, failed } = runSession([
    { op: 'check', invoiceId: 'GHOST' },
    { op: 'invoice', id: 'BIG', vars: ['a', 'b', 'c', 'd'], constraints: [] },
  ]);
  assert.equal(results[0].error, 'E_REF');
  assert.equal(results[1].error, 'E_DIM');
  assert.equal(failed, true);
});

test('CLI parser accepts JSON arrays and JSON Lines', () => {
  const asArray = parseSession(JSON.stringify(SESSION));
  const asLines = parseSession(SESSION.map((o) => JSON.stringify(o)).join('\n'));
  assert.deepEqual(asArray, asLines);
  assert.equal(asArray.length, 4);
});

test('CLI executable end-to-end (skipped when child processes are sandboxed)', (t) => {
  const file = join(tmpdir(), `redflush-cli-${process.pid}.jsonl`);
  writeFileSync(file, SESSION.map((o) => JSON.stringify(o)).join('\n'));
  try {
    const run = spawnSync(process.execPath, [CLI, file], { encoding: 'utf8' });
    if (run.error) {
      t.skip(`child processes not permitted in this sandbox (${run.error.code ?? run.error.message})`);
      return;
    }
    const lines = run.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[2].status, 'SAT');
    assert.equal(lines[3].error, 'E_PINNED');
    assert.equal(run.status, 1);
  } finally {
    rmSync(file, { force: true });
  }
});
