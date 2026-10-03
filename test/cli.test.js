import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli, tmpdir, inputFile, readJsonl, BIN } from './helpers/cli.js';

const hold = { id: 'e1', ts: 1000, device: 'plc-1', lot: 'L1', kind: 'quality.hold', payload: {} };
const badRelease = { id: 'e2', ts: 2000, device: 'plc-1', lot: 'L2', kind: 'quality.release', payload: {} };

test('ingest: VALIDATION exits 2 with JSON on stderr', () => {
  const dir = tmpdir();
  const r = runCli(['ingest', '--dir', dir, '--file', inputFile([hold, badRelease])]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.code, 2);
  assert.equal(err.error, 'VALIDATION');
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.applied, ['e1']);
  assert.equal(report.rejected.length, 1);
});

test('ingest: malformed JSON lines are reported and exit 2', () => {
  const dir = tmpdir();
  const file = path.join(tmpdir(), 'bad.jsonl');
  fs.writeFileSync(file, JSON.stringify(hold) + '\n{not json}\n');
  const r = runCli(['ingest', '--dir', dir, '--file', file]);
  assert.equal(r.status, 2);
  const report = JSON.parse(r.stdout);
  assert.equal(report.malformed.length, 1);
  assert.deepEqual(report.applied, ['e1']);
});

test('cert: unknown lot exits 3; missing --lot exits 3', () => {
  const dir = tmpdir();
  runCli(['ingest', '--dir', dir, '--file', inputFile([hold])]);
  let r = runCli(['cert', '--dir', dir, '--lot', 'NOPE']);
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stderr).error, 'NOT_FOUND');
  r = runCli(['cert', '--dir', dir]);
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stderr).error, 'USAGE');
});

test('unknown command exits 3 with USAGE', () => {
  const r = runCli(['frobnicate']);
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stderr).error, 'USAGE');
});

test('corrupt state file exits 4 with INTERNAL', () => {
  const dir = tmpdir();
  runCli(['ingest', '--dir', dir, '--file', inputFile([hold])]);
  fs.writeFileSync(path.join(dir, 'lots.json'), '{corrupt');
  const r = runCli(['audit', '--dir', dir]);
  assert.equal(r.status, 4);
  assert.equal(JSON.parse(r.stderr).code, 4);
});

test('sync: missing remote exits 3', () => {
  const r = runCli(['sync', '--dir', tmpdir(), '--remote', '/nonexistent/dir/xyz']);
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stderr).error, 'NOT_FOUND');
});

test('audit prints JSONL decision records, filterable by lot', () => {
  const dir = tmpdir();
  const e2 = { id: 'e2', ts: 2000, device: 'plc-1', lot: 'L2', kind: 'device.alarm', payload: {} };
  runCli(['ingest', '--dir', dir, '--file', inputFile([hold, e2])]);
  let r = runCli(['audit', '--dir', dir]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split('\n').length, 2);
  r = runCli(['audit', '--dir', dir, '--lot', 'L2']);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 'e2');
  assert.equal(lines[0].decision, 'applied');
});

test('ingest reads JSONL from stdin (shell pipe)', () => {
  const dir = tmpdir();
  const out = path.join(tmpdir(), 'out.json');
  const cmd = `printf '%s\\n' '${JSON.stringify(hold)}' | "${process.execPath}" "${BIN}" ingest --dir "${dir}" > "${out}"`;
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(report.applied, ['e1']);
});

test('resume on a healthy dir is a no-op', () => {
  const dir = tmpdir();
  runCli(['ingest', '--dir', dir, '--file', inputFile([hold])]);
  const r = runCli(['resume', '--dir', dir]);
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.replayed, 0);
  assert.equal(report.inboxProcessed, 0);
  assert.equal(report.applied, 1);
});
