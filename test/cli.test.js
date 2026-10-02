import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

let dir;
let db;

// Invoke the CLI in-process, capturing output and the exit code.
function cli(args) {
  let stdout = '';
  let stderr = '';
  const status = run(args, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { status, stdout, stderr };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'auditdb-cli-'));
  db = join(dir, 'test.db.json');
  writeFileSync(join(dir, 'events.jsonl'), [
    JSON.stringify({ id: 'e1', account: 'acc', txSeq: 1, validFrom: '2024-01-01T00:00:00Z', validTo: null, payload: { amount: 100, limit: 20 } }),
    JSON.stringify({ id: 'e2', account: 'acc', txSeq: 2, validFrom: '2024-01-01T00:00:00Z', validTo: null, payload: { amount: 300, limit: 20 }, supersedes: 'e1' }),
    JSON.stringify({ id: 't1', account: 'acc', txSeq: 3, tombstone: true, supersedes: 'e2' }),
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'bad.jsonl'), JSON.stringify({ id: 'bad', account: 'acc', txSeq: 4, validFrom: '2024-02-01T00:00:00Z', validTo: '2024-01-01T00:00:00Z' }) + '\n');
  writeFileSync(join(dir, 'badtomb.jsonl'), JSON.stringify({ id: 'tx', account: 'acc', txSeq: 4, tombstone: true, supersedes: 'ghost' }) + '\n');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('CLI load then query respects --valid/--tx', () => {
  const load = cli(['load', join(dir, 'events.jsonl'), '--db', db]);
  assert.equal(load.status, 0, load.stderr);
  assert.deepEqual(JSON.parse(load.stdout), { loaded: 3, total: 3, db });

  const q1 = cli(['query', 'acc', '--valid', '2024-06-01T00:00:00Z', '--tx', '1', '--db', db]);
  assert.equal(q1.status, 0, q1.stderr);
  assert.deepEqual(JSON.parse(q1.stdout), { account: 'acc', validTime: '2024-06-01T00:00:00Z', txSeq: 1, balance: 100, limitUsed: 20, versions: 1 });

  const q2 = cli(['query', 'acc', '--valid', '2024-06-01T00:00:00Z', '--tx', '2', '--db', db]);
  assert.equal(JSON.parse(q2.stdout).balance, 300); // backfilled correction visible

  const q3 = cli(['query', 'acc', '--valid', '2024-06-01T00:00:00Z', '--tx', '3', '--db', db]);
  assert.equal(JSON.parse(q3.stdout).versions, 0); // tombstoned
});

test('CLI exits non-zero with E_TIME_ORDER on bad input', () => {
  const r = cli(['load', join(dir, 'bad.jsonl'), '--db', db]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /E_TIME_ORDER/);
});

test('CLI exits non-zero with E_TOMBSTONE on bad delete', () => {
  const r = cli(['load', join(dir, 'badtomb.jsonl'), '--db', db]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /E_TOMBSTONE/);
});

test('CLI usage errors exit non-zero', () => {
  assert.notEqual(cli(['query', 'acc', '--db', db]).status, 0);
  assert.notEqual(cli(['nonsense']).status, 0);
});
