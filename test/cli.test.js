import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, EXIT } from '../src/cli.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logdb-cli-'));
}

// Runs the CLI in-process and captures exactly what it would print plus the
// exit code the process would return.
function run(args) {
  const stdout = [];
  const stderr = [];
  const code = runCli(args, {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function setupLogs(dir) {
  const file = path.join(dir, 'log.jsonl');
  fs.writeFileSync(file, [
    { ts: '2026-10-01T08:00:00Z', device: 'pump-1', code: 'I100', value: 12.5 },
    { ts: '2026-10-01T09:30:00Z', device: 'pump-2', code: 'E200', value: 1500 },
    { ts: '2026-10-01T07:15:00Z', device: 'valve-1', code: 'I101', value: 3 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

test('append + query roundtrip exits 0 and prints sorted records', () => {
  const dir = tmpDir();
  const log = setupLogs(dir);
  const db = path.join(dir, 'db');
  const a = run(['append', log, '--db', db]);
  assert.equal(a.code, EXIT.OK, a.stderr);
  assert.match(a.stdout, /APPENDED 3/);

  const dsl = path.join(dir, 'q.dsl');
  fs.writeFileSync(dsl, 'value > 10');
  const q = run(['query', dsl, '--db', db]);
  assert.equal(q.code, EXIT.OK, q.stderr);
  const rows = q.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.device), ['pump-1', 'pump-2']); // sorted by ts
});

test('query syntax error exits 2', () => {
  const dir = tmpDir();
  const db = path.join(dir, 'db');
  run(['append', setupLogs(dir), '--db', db]);
  const dsl = path.join(dir, 'bad.dsl');
  fs.writeFileSync(dsl, 'value >');
  const q = run(['query', dsl, '--db', db]);
  assert.equal(q.code, EXIT.SYNTAX);
  assert.match(q.stderr, /SYNTAX_ERROR/);
});

test('unknown field and type errors exit 3', () => {
  const dir = tmpDir();
  const db = path.join(dir, 'db');
  run(['append', setupLogs(dir), '--db', db]);
  const dsl = path.join(dir, 'q.dsl');
  fs.writeFileSync(dsl, 'temperature > 3');
  assert.equal(run(['query', dsl, '--db', db]).code, EXIT.TYPE);
  fs.writeFileSync(dsl, 'value < "abc"');
  const q = run(['query', dsl, '--db', db]);
  assert.equal(q.code, EXIT.TYPE);
  assert.match(q.stderr, /TYPE_ERROR/);
});

test('recover prints RECOVERY_ERROR and exits 1 on a corrupt manifest', () => {
  const dir = tmpDir();
  const db = path.join(dir, 'db');
  run(['append', setupLogs(dir), '--db', db]);
  fs.writeFileSync(path.join(db, 'manifest.json'), 'not json at all');
  const r = run(['recover', '--db', db]);
  assert.equal(r.code, EXIT.ERROR);
  assert.match(r.stderr, /RECOVERY_ERROR/);
});

test('recover truncates a corrupt WAL tail and keeps the committed prefix', () => {
  const dir = tmpDir();
  const db = path.join(dir, 'db');
  run(['append', setupLogs(dir), '--db', db]);
  // simulate a torn write: garbage appended to the WAL
  fs.appendFileSync(path.join(db, 'wal.log'), Buffer.from([9, 0, 0, 0, 65, 66]));
  const r = run(['recover', '--db', db]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.match(r.stdout, /truncatedWalBytes=6/);
  const dsl = path.join(dir, 'q.dsl');
  fs.writeFileSync(dsl, 'value >= 0 | count');
  const q = run(['query', dsl, '--db', db]);
  assert.equal(q.stdout, '{"count":3}');
});

test('recover on a missing database prints RECOVERY_ERROR', () => {
  const dir = tmpDir();
  const r = run(['recover', '--db', path.join(dir, 'nope')]);
  assert.equal(r.code, EXIT.ERROR);
  assert.match(r.stderr, /RECOVERY_ERROR/);
});

test('invalid log input exits 1', () => {
  const dir = tmpDir();
  const log = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(log, '{"ts":"2026-10-01T00:00:00Z","device":"a","code":"X","value":"oops"}\n');
  const a = run(['append', log, '--db', path.join(dir, 'db')]);
  assert.equal(a.code, EXIT.ERROR);
  assert.match(a.stderr, /ERROR/);
});

test('unknown command exits 1', () => {
  assert.equal(run(['frobnicate']).code, EXIT.ERROR);
});
