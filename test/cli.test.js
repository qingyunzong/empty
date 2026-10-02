'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, runCli } = require('./helpers');

function setup() {
  const dir = tmpDir('cli-');
  const db = path.join(dir, 'db');
  const logFile = path.join(dir, 'log.jsonl');
  fs.writeFileSync(logFile, [
    JSON.stringify({ ts: '2026-10-01T08:00:03Z', device: 'pump-01', code: 'TEMP', value: 71.5 }),
    JSON.stringify({ ts: '2026-10-01T08:00:01Z', device: 'pump-02', code: 'TEMP', value: 66 }),
    JSON.stringify({ ts: '2026-10-01T08:00:02Z', device: 'valve-1', code: 'PRESS', value: 1200 }),
  ].join('\n') + '\n');
  return { dir, db, logFile };
}

test('append then query roundtrip with exit code 0', () => {
  const { dir, db, logFile } = setup();
  const app = runCli(['append', logFile, '--db', db]);
  assert.equal(app.status, 0, app.stderr);
  assert.match(app.stdout, /APPENDED 3/);
  const dsl = path.join(dir, 'q.dsl');
  fs.writeFileSync(dsl, 'where device matches "pump-*"');
  const q = runCli(['query', dsl, '--db', db]);
  assert.equal(q.status, 0, q.stderr);
  const rows = q.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.device), ['pump-02', 'pump-01']);
});

test('query with syntax error exits 2', () => {
  const { dir, db, logFile } = setup();
  runCli(['append', logFile, '--db', db]);
  const dsl = path.join(dir, 'bad.dsl');
  fs.writeFileSync(dsl, 'where device ==');
  const q = runCli(['query', dsl, '--db', db]);
  assert.equal(q.status, 2);
  assert.match(q.stderr, /QUERY_ERROR/);
});

test('query with unknown field exits 2', () => {
  const { dir, db, logFile } = setup();
  runCli(['append', logFile, '--db', db]);
  const dsl = path.join(dir, 'bad.dsl');
  fs.writeFileSync(dsl, 'where pressure > 3');
  const q = runCli(['query', dsl, '--db', db]);
  assert.equal(q.status, 2);
  assert.match(q.stderr, /unknown field/);
});

test('query with type error exits 2', () => {
  const { dir, db, logFile } = setup();
  runCli(['append', logFile, '--db', db]);
  const dsl = path.join(dir, 'bad.dsl');
  fs.writeFileSync(dsl, 'where ts > 5');
  const q = runCli(['query', dsl, '--db', db]);
  assert.equal(q.status, 2);
  assert.match(q.stderr, /QUERY_ERROR/);
});

test('recover on healthy db prints RECOVERY_OK', () => {
  const { db, logFile } = setup();
  runCli(['append', logFile, '--db', db]);
  const r = runCli(['recover', '--db', db]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RECOVERY_OK/);
});

test('recover on corrupt manifest prints RECOVERY_ERROR and exits 1', () => {
  const { db, logFile } = setup();
  runCli(['append', logFile, '--db', db]);
  fs.writeFileSync(path.join(db, 'manifest.json'), '{broken');
  const r = runCli(['recover', '--db', db]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /RECOVERY_ERROR/);
});

test('recover on missing db prints RECOVERY_ERROR and exits 1', () => {
  const { dir } = setup();
  const r = runCli(['recover', '--db', path.join(dir, 'nope')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /RECOVERY_ERROR/);
});

test('recover truncates corrupt wal tail end-to-end', () => {
  const { db, logFile } = setup();
  runCli(['append', logFile, '--db', db]);
  fs.appendFileSync(path.join(db, 'wal.log'), '{"crc":1,"payload":"trunc');
  const r = runCli(['recover', '--db', db]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /truncated_bytes=[1-9]/);
  const dsl = path.join(db, '..', 'q.dsl');
  fs.writeFileSync(dsl, 'select count()');
  const q = runCli(['query', dsl, '--db', db]);
  assert.deepEqual(JSON.parse(q.stdout), { 'count()': 3 });
});

test('append rejects malformed log lines with exit 1', () => {
  const { dir, db } = setup();
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, JSON.stringify({ ts: 'not-a-time', device: 'x', code: 'C', value: 1 }) + '\n');
  const r = runCli(['append', bad, '--db', db]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ERROR/);
});

test('aggregate query via CLI prints JSON object', () => {
  const { dir, db, logFile } = setup();
  runCli(['append', logFile, '--db', db]);
  const dsl = path.join(dir, 'agg.dsl');
  fs.writeFileSync(dsl, 'select count(), max(value) where value > 100');
  const q = runCli(['query', dsl, '--db', db]);
  assert.equal(q.status, 0, q.stderr);
  assert.deepEqual(JSON.parse(q.stdout), { 'count()': 1, 'max(value)': 1200 });
});
