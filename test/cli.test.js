'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agv-chain-'));
}

test('CLI writes a certificate for a valid batch', () => {
  const dir = tmpdir();
  const evFile = path.join(dir, 'ev.jsonl');
  const certFile = path.join(dir, 'c.json');
  const lines = [
    { type: 'ASSIGN', job: 'jobA', leg: 'L1', seq: 0, causes: [], ts: 0 },
    { type: 'PICK', job: 'jobA', leg: 'L1', seq: 1, causes: [], ts: 10 },
    { type: 'DROP', job: 'jobA', leg: 'L1', seq: 2, causes: [], ts: 20 },
  ];
  fs.writeFileSync(evFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const res = runCli([evFile, '--cert', certFile]);
  assert.equal(res.status, 0, res.stderr);
  const cert = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  assert.equal(cert.eventCount, 3);
  assert.match(cert.chainHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(cert.staleLog, []);
});

test('CLI tolerates fragmented frames (no newlines, split objects)', () => {
  const dir = tmpdir();
  const evFile = path.join(dir, 'ev.jsonl');
  const certFile = path.join(dir, 'c.json');
  const a = JSON.stringify({ type: 'ASSIGN', job: 'j', leg: 'L1', seq: 0, causes: [], ts: 0 });
  const b = JSON.stringify({ type: 'DROP', job: 'j', leg: 'L1', seq: 1, causes: [], ts: 5 });
  // Fragments concatenated without separators, plus a stray newline mid-stream.
  fs.writeFileSync(evFile, a.slice(0, 20) + a.slice(20) + '\n' + b.slice(0, 10) + b.slice(10));
  const res = runCli([evFile, '--cert', certFile]);
  assert.equal(res.status, 0, res.stderr);
  const cert = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  assert.equal(cert.eventCount, 2);
});

test('CLI exits 14 when causes form a cycle', () => {
  const dir = tmpdir();
  const evFile = path.join(dir, 'ev.jsonl');
  const certFile = path.join(dir, 'c.json');
  const lines = [
    { type: 'ASSIGN', job: 'A', leg: 'L1', seq: 0, causes: ['B'], ts: 0 },
    { type: 'ASSIGN', job: 'B', leg: 'L1', seq: 0, causes: ['A'], ts: 1 },
  ];
  fs.writeFileSync(evFile, lines.map((l) => JSON.stringify(l)).join('\n'));
  const res = runCli([evFile, '--cert', certFile]);
  assert.equal(res.status, 14, `stderr: ${res.stderr}`);
  assert.equal(fs.existsSync(certFile), false, 'no certificate on rejection');
});

test('CLI exits 15 for RETRY after a non-FAIL event', () => {
  const dir = tmpdir();
  const evFile = path.join(dir, 'ev.jsonl');
  const certFile = path.join(dir, 'c.json');
  const lines = [
    { type: 'ASSIGN', job: 'A', leg: 'L1', seq: 0, causes: [], ts: 0 },
    { type: 'PICK', job: 'A', leg: 'L1', seq: 1, causes: [], ts: 1 },
    { type: 'RETRY', job: 'A', leg: 'L2', seq: 2, causes: [], ts: 2 },
  ];
  fs.writeFileSync(evFile, lines.map((l) => JSON.stringify(l)).join('\n'));
  const res = runCli([evFile, '--cert', certFile]);
  assert.equal(res.status, 15, `stderr: ${res.stderr}`);
});

test('CLI exits 15 for RETRY reusing an old leg', () => {
  const dir = tmpdir();
  const evFile = path.join(dir, 'ev.jsonl');
  const certFile = path.join(dir, 'c.json');
  const lines = [
    { type: 'FAIL', job: 'A', leg: 'L1', seq: 0, causes: [], ts: 0 },
    { type: 'RETRY', job: 'A', leg: 'L1', seq: 1, causes: [], ts: 1 },
  ];
  fs.writeFileSync(evFile, lines.map((l) => JSON.stringify(l)).join('\n'));
  const res = runCli([evFile, '--cert', certFile]);
  assert.equal(res.status, 15, `stderr: ${res.stderr}`);
});

test('CLI certificate records stale revocation', () => {
  const dir = tmpdir();
  const evFile = path.join(dir, 'ev.jsonl');
  const certFile = path.join(dir, 'c.json');
  const lines = [
    { type: 'PICK', job: 'A', leg: 'L1', seq: 0, causes: [], ts: 0 },
    { type: 'ASSIGN', job: 'B', leg: 'L1', seq: 0, causes: [], ts: 1000 },
    { type: 'DROP', job: 'A', leg: 'L1', seq: 1, causes: [], ts: 2000 },
  ];
  fs.writeFileSync(evFile, lines.map((l) => JSON.stringify(l)).join('\n'));
  const res = runCli([evFile, '--cert', certFile, '--timeout-ms', '100']);
  assert.equal(res.status, 0, res.stderr);
  const cert = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  assert.equal(cert.staleLog.length, 1);
  assert.equal(cert.staleLog[0].revoked, true);
  assert.equal(cert.staleLog[0].revokedAt, 2000);
});
