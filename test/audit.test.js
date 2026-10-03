import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { commit, readWal, loadStateAt, AuditError } from '../src/store.js';
import { verify } from '../src/verify.js';

const CLI = path.resolve(import.meta.dirname, '../src/cli.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
}

let cliCounter = 0;

// The sandbox swallows grandchild stdio pipes, so capture via temp files.
function runCli(args) {
  const tag = `cli-${process.pid}-${cliCounter += 1}`;
  const outFile = path.join(os.tmpdir(), `${tag}.out`);
  const errFile = path.join(os.tmpdir(), `${tag}.err`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  return {
    code: res.status,
    stdout: stdout.trim() ? JSON.parse(stdout) : null,
    stderr: stderr.trim(),
  };
}

// --- Independent reference implementation (deliberately not imported from src) ---

function refCanonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(refCanonical).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + refCanonical(value[k]))
    .join(',') + '}';
}

function refSha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Recompute the whole certificate chain from the enumerated WAL records.
function refRecomputeChain(records) {
  const certs = [];
  let prev = '0'.repeat(64);
  for (const rec of records) {
    const opHash = refSha256(refCanonical(rec.op));
    const unsigned = {
      version: rec.certificate.version,
      parentVersion: rec.certificate.parentVersion,
      snapshotVersion: rec.certificate.snapshotVersion,
      opHash,
      prevCertHash: prev,
    };
    const digest = refSha256(refCanonical(unsigned));
    certs.push({ ...unsigned, digest });
    prev = digest;
  }
  return certs;
}

// --- Acceptance 1: three commits, verify passes, as-of visibility ---

test('three commits verify cleanly and as-of snapshots respect visibility', async () => {
  const dir = tmpDir();
  await commit(dir, { type: 'payment', party: 'alice', amount: 100, txId: 'tx-1' });
  await commit(dir, { type: 'payment', party: 'bob', amount: 50, txId: 'tx-2' });
  await commit(dir, { type: 'settlement', from: 'alice', to: 'bob', amount: 25, txId: 'tx-3' });

  const result = verify(dir);
  assert.deepEqual({ ok: result.ok, versions: result.versions }, { ok: true, versions: 3 });

  const v1 = loadStateAt(dir, 1);
  assert.deepEqual(v1.balances, { alice: 100 });
  assert.equal(v1.transactions['tx-2'], undefined, 'tx-2 must not be visible at v1');

  const v2 = loadStateAt(dir, 2);
  assert.deepEqual(v2.balances, { alice: 100, bob: 50 });
  assert.equal(v2.transactions['tx-3'], undefined, 'tx-3 must not be visible at v2');

  const v3 = loadStateAt(dir, 3);
  assert.deepEqual(v3.balances, { alice: 75, bob: 75 });
  assert.equal(v3.transactions['tx-1'].status, 'active');

  // CLI view of the same as-of queries.
  const at1 = runCli(['get', '--data', dir, '--at', '1']);
  assert.equal(at1.code, 0);
  assert.deepEqual(at1.stdout.state.balances, { alice: 100 });
  const auditAlice = runCli(['audit', '--data', dir, '--party', 'alice']);
  assert.equal(auditAlice.stdout.entries.length, 2);
  const auditAliceAt1 = runCli(['audit', '--data', dir, '--party', 'alice', '--at', '1']);
  assert.deepEqual(auditAliceAt1.stdout.entries.map((e) => e.txId), ['tx-1']);
  const cliVerify = runCli(['verify', '--data', dir]);
  assert.equal(cliVerify.code, 0);
  assert.equal(cliVerify.stdout.ok, true);
});

// --- Acceptance 2: concurrent reversals, exactly one wins, chain stays intact ---

test('concurrent reversals of one transaction: one commits, one gets E_CONFLICT', async () => {
  const dir = tmpDir();
  await commit(dir, { type: 'payment', party: 'alice', amount: 100, txId: 'tx-1' });

  const settled = await Promise.allSettled([
    commit(dir, { type: 'reversal', reverses: 'tx-1', txId: 'rev-a' }),
    commit(dir, { type: 'reversal', reverses: 'tx-1', txId: 'rev-b' }),
  ]);
  const fulfilled = settled.filter((r) => r.status === 'fulfilled');
  const rejected = settled.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one reversal must commit');
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof AuditError);
  assert.equal(rejected[0].reason.code, 'E_CONFLICT');

  // Certificate chain is continuous: no gap, no fork from the failed commit.
  const records = readWal(dir);
  assert.equal(records.length, 3, 'genesis + payment + one reversal only');
  for (let i = 1; i < records.length; i += 1) {
    assert.equal(records[i].seq, i);
    assert.equal(records[i].certificate.prevCertHash, records[i - 1].certificate.digest);
    assert.equal(records[i].certificate.parentVersion, records[i - 1].certificate.version);
  }
  assert.equal(verify(dir).ok, true);

  // Reverse entry persisted as a negative entry; original marked, never deleted.
  const head = loadStateAt(dir, 2);
  assert.equal(head.transactions['tx-1'].status, 'reversed');
  assert.equal(head.balances.alice, 0);
  const winner = fulfilled[0].value;
  const winnerTx = head.transactions[winner.version === 2 ? (head.transactions['rev-a'] ? 'rev-a' : 'rev-b') : null];
  assert.equal(winnerTx.type, 'reversal');
  assert.equal(winnerTx.amount, -100);
  assert.equal(loadStateAt(dir, 1).transactions['tx-1'].status, 'active', 'old version untouched');
});

// --- Acceptance 3: tampered WAL copy is detected at the first bad sequence ---

test('modifying any WAL amount in a copied dir yields E_TAMPER at that seq', async () => {
  const dir = tmpDir();
  await commit(dir, { type: 'payment', party: 'alice', amount: 100, txId: 'tx-1' });
  await commit(dir, { type: 'payment', party: 'bob', amount: 50, txId: 'tx-2' });
  await commit(dir, { type: 'settlement', from: 'alice', to: 'bob', amount: 25, txId: 'tx-3' });
  assert.equal(verify(dir).ok, true);

  const copy = tmpDir();
  fs.cpSync(dir, copy, { recursive: true });
  const walFile = path.join(copy, 'wal.log');
  const records = readWal(copy);
  records[2].op.amount = 999; // tamper with bob's payment
  fs.writeFileSync(walFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const result = verify(copy);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_TAMPER');
  assert.equal(result.seq, 2, 'must locate the first mismatched sequence number');

  // Original directory is unaffected.
  assert.equal(verify(dir).ok, true);

  // The CLI tamper-test automates the same drill on its own copy.
  const cli = runCli(['tamper-test', '--data', dir]);
  assert.equal(cli.code, 0);
  assert.equal(cli.stdout.ok, true);
  assert.equal(cli.stdout.result.code, 'E_TAMPER');
  assert.equal(cli.stdout.result.seq, cli.stdout.corruptedSeq);
});

// --- Reference test: independent canonicalization + hash recomputation ---

test('reference recomputation of canonical hashes matches stored certificates', async () => {
  const dir = tmpDir();
  await commit(dir, { type: 'payment', party: 'alice', amount: 100, txId: 'tx-1' });
  await commit(dir, { type: 'settlement', from: 'alice', to: 'bob', amount: 40, txId: 'tx-2' });
  await commit(dir, { type: 'reversal', reverses: 'tx-1', txId: 'tx-3' });

  const records = readWal(dir);
  const expected = refRecomputeChain(records);
  assert.equal(expected.length, records.length);
  for (let i = 0; i < records.length; i += 1) {
    assert.equal(records[i].certificate.opHash, expected[i].opHash, `opHash at seq ${i}`);
    assert.equal(records[i].certificate.digest, expected[i].digest, `digest at seq ${i}`);
    assert.equal(records[i].certificate.prevCertHash, expected[i].prevCertHash, `link at seq ${i}`);
  }
  assert.equal(verify(dir).ok, true);
});

// --- CLI commit / conflict exit behaviour ---

test('CLI commit prints certificate and second reversal exits with E_CONFLICT', async () => {
  const dir = tmpDir();
  const pay = runCli(['commit', '--data', dir, '--type', 'payment', '--party', 'alice', '--amount', '10', '--tx-id', 'tx-1']);
  assert.equal(pay.code, 0);
  assert.equal(pay.stdout.certificate.version, 1);
  assert.equal(pay.stdout.certificate.parentVersion, 0);
  assert.match(pay.stdout.certificate.digest, /^[0-9a-f]{64}$/);

  const rev1 = runCli(['commit', '--data', dir, '--type', 'reversal', '--reverses', 'tx-1']);
  assert.equal(rev1.code, 0);
  const rev2 = runCli(['commit', '--data', dir, '--type', 'reversal', '--reverses', 'tx-1']);
  assert.equal(rev2.code, 1);
  assert.match(rev2.stderr, /E_CONFLICT/);
  assert.equal(verify(dir).ok, true);
});
