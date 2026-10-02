import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProof } from '../src/merkle.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Sandboxed environments may forbid piped child stdio, so capture via files.
function runCli({ input, args = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cli-'));
  const outFile = path.join(dir, 'out.jsonl');
  const errFile = path.join(dir, 'err.txt');
  const statusFile = path.join(dir, 'status.txt');
  const cliCmd = [process.execPath, CLI, ...args].map(shellQuote).join(' ');
  let cmd;
  if (input != null) {
    const inFile = path.join(dir, 'in.jsonl');
    fs.writeFileSync(inFile, input);
    cmd = `${cliCmd} < ${shellQuote(inFile)}`;
  } else {
    cmd = cliCmd;
  }
  cmd += ` > ${shellQuote(outFile)} 2> ${shellQuote(errFile)}; echo -n $? > ${shellQuote(statusFile)}`;
  spawnSync('/bin/bash', ['-c', cmd], { stdio: 'inherit' });
  return {
    status: Number(fs.readFileSync(statusFile, 'utf8')),
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}

const OPS = [
  { op: 'snapshot', id: 'fx', rates: { USD: '7.1' } },
  { op: 'voucher', id: 'v1', lamport: 1, postings: [{ account: 'cash', amount: '100', currency: 'BASE' }] },
  { op: 'voucher', id: 'v2', lamport: 2, snapshot: 'fx', postings: [{ account: 'cash', amount: '10', currency: 'USD' }] },
  { op: 'reverse', id: 'r1', lamport: 3, target: 'v1' },
];

function opsWithCertify(certPath) {
  return [...OPS, { op: 'certify', path: certPath }, { op: 'verify', path: certPath }]
    .map((o) => JSON.stringify(o)).join('\n') + '\n';
}

test('CLI emits per-step root, invalidation set and proof path; certificate verifies', () => {
  const dir = tmpdir();
  const certPath = path.join(dir, 'cert.json');
  const res = runCli({ input: opsWithCertify(certPath) });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');

  const lines = res.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 6);
  for (const line of lines) assert.match(line.root, /^[0-9a-f]{64}$/);

  // Reverse step: v2 depends on v1 via account cash -> invalidated.
  assert.deepEqual(lines[3].invalidated, ['v2']);
  // Proof path verifies against the step's merkle root.
  const proof = lines[1].proof;
  assert.equal(proof.id, 'v1');
  assert.ok(verifyProof(proof.leaf, proof.path, proof.merkleRoot));
  // In-stream verify op agrees.
  assert.equal(lines[5].ok, true);

  // Standalone verification after process exit.
  const verify = runCli({ args: ['--verify', certPath] });
  assert.equal(verify.status, 0, verify.stderr);
  const out = JSON.parse(verify.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.root, lines.at(-1).root);
  assert.deepEqual(out.invalidated, ['v2']);
});

test('crash mid certificate write is detected on restart; re-certify recovers', () => {
  const dir = tmpdir();
  const certPath = path.join(dir, 'cert.json');
  const ops = opsWithCertify(certPath);
  assert.equal(runCli({ input: ops }).status, 0);

  // Simulate a crash halfway through the certificate write.
  const full = fs.readFileSync(certPath, 'utf8');
  fs.writeFileSync(certPath, full.slice(0, Math.floor(full.length / 2)));

  const bad = runCli({ args: ['--verify', certPath] });
  assert.equal(bad.status, 3);
  assert.equal(bad.stdout, '');
  assert.equal(JSON.parse(bad.stderr).error, 'CERT_INCOMPLETE');

  // Restart: replay the journal, re-certify, verification passes again.
  assert.equal(runCli({ input: ops }).status, 0);
  const good = runCli({ args: ['--verify', certPath] });
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).ok, true);
});

test('corrupted certificate content fails checksum with CERT_CORRUPT', () => {
  const dir = tmpdir();
  const certPath = path.join(dir, 'cert.json');
  assert.equal(runCli({ input: opsWithCertify(certPath) }).status, 0);

  const cert = JSON.parse(fs.readFileSync(certPath, 'utf8'));
  cert.balances.cash = '999';
  fs.writeFileSync(certPath, JSON.stringify(cert, null, 2));

  const res = runCli({ args: ['--verify', certPath] });
  assert.equal(res.status, 3);
  assert.equal(JSON.parse(res.stderr).error, 'CERT_CORRUPT');
});

test('missing snapshot exits 3 with MISSING_SNAPSHOT on stderr', () => {
  const ops = JSON.stringify({
    op: 'voucher', id: 'v1', lamport: 1, snapshot: 'ghost',
    postings: [{ account: 'cash', amount: '1', currency: 'USD' }],
  }) + '\n';
  const res = runCli({ input: ops });
  assert.equal(res.status, 3);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error, 'MISSING_SNAPSHOT');
  // The pending step was still reported on stdout before finalization failed.
  const lines = res.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].pending, true);
});

test('mid-stream insertion via CLI reports the cascade invalidation set', () => {
  const ops = [
    { op: 'voucher', id: 'v1', lamport: 1, postings: [{ account: 'cash', amount: '100', currency: 'BASE' }] },
    { op: 'voucher', id: 'v2', lamport: 2, postings: [{ account: 'cash', amount: '5', currency: 'BASE' }] },
    { op: 'voucher', id: 'v3', lamport: 3, postings: [{ account: 'cash', amount: '7', currency: 'BASE' }] },
    { op: 'voucher', id: 'v1b', lamport: 1, postings: [{ account: 'cash', amount: '1', currency: 'BASE' }] },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  const res = runCli({ input: ops });
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[3].invalidated, ['v2', 'v3']);
  assert.notEqual(lines[3].root, lines[2].root);
});
