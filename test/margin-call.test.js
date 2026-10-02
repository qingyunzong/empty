import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runMarginCall, SimulatedCrashError } from '../src/margin-call.js';

const CLI_PATH = new URL('../src/cli.js', import.meta.url).pathname;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'margin-call-'));
}

// --- Independent brute-force reference model (shares no code with the library) ---

function bruteForce(event) {
  const sorted = [...event.accounts].sort((a, b) =>
    a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cancelAt = event.faults?.cancelAfterAccount ?? null;
  const freezes = [];
  let total = 0;
  let cancelled = false;
  for (let i = 0; i < sorted.length; i++) {
    if (cancelAt != null && i > cancelAt) { cancelled = true; break; }
    if (total >= event.targetAmount) break;
    const amount = Math.min(event.targetAmount - total, sorted[i].available);
    if (amount > 0) freezes.push({ accountId: sorted[i].id, amount });
    total += amount;
  }
  if (!cancelled && total >= event.targetAmount) {
    return { status: 'CONFIRMED', freezes, rollbacks: [] };
  }
  return { status: cancelled ? 'CANCELLED' : 'FAILED', freezes, rollbacks: [...freezes].reverse() };
}

function runToCompletion(event, logDir) {
  for (let guard = 0; guard < event.accounts.length + 3; guard++) {
    try {
      return runMarginCall(event, logDir);
    } catch (err) {
      if (err instanceof SimulatedCrashError) continue;
      throw err;
    }
  }
  throw new Error('recovery did not converge');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function assertCertificateValid(result) {
  const cert = result.certificate;
  assert.ok(cert, 'certificate must be present');
  assert.equal(cert.callId, result.callId);
  assert.equal(cert.targetAmount, result.targetAmount);
  assert.equal(cert.totalFrozen, result.totalFrozen);
  assert.deepEqual(cert.freezes, result.freezes);
  const body = { callId: cert.callId, targetAmount: cert.targetAmount, totalFrozen: cert.totalFrozen, freezes: cert.freezes };
  const digest = crypto.createHash('sha256').update(stableStringify(body)).digest('hex');
  assert.equal(cert.digest, digest);
}

function assertNoOrphanFreezes(result) {
  for (const [accountId, amount] of Object.entries(result.netFrozen)) {
    assert.equal(amount, 0, `orphan freeze on account ${accountId}`);
  }
  const frozen = [...result.freezes].sort((a, b) => a.accountId.localeCompare(b.accountId));
  const rolled = [...result.rollbacks].sort((a, b) => a.accountId.localeCompare(b.accountId));
  assert.deepEqual(rolled, frozen, 'rollback multiset must equal freeze multiset');
}

// --- Acceptance: sufficient funds deducted by priority, certificate correct ---

test('sufficient funds: freezes follow priority order and certificate is correct', () => {
  const dir = tmpDir();
  const event = {
    callId: 'ok-1',
    targetAmount: 100,
    accounts: [
      { id: 'low', priority: 3, available: 10 },
      { id: 'high', priority: 1, available: 50 },
      { id: 'mid', priority: 2, available: 80 },
    ],
  };
  const result = runMarginCall(event, dir);
  assert.equal(result.status, 'CONFIRMED');
  assert.deepEqual(result.freezes, [
    { accountId: 'high', amount: 50 },
    { accountId: 'mid', amount: 50 },
  ]);
  assert.equal(result.totalFrozen, 100);
  assert.deepEqual(result.rollbacks, []);
  assert.deepEqual(result.netFrozen, { high: 50, mid: 50 });
  assertCertificateValid(result);
});

// --- Acceptance: insufficient funds roll everything back ---

test('insufficient funds: all frozen amounts are rolled back in reverse order', () => {
  const dir = tmpDir();
  const event = {
    callId: 'short-1',
    targetAmount: 100,
    accounts: [
      { id: 'a', priority: 1, available: 30 },
      { id: 'b', priority: 2, available: 40 },
      { id: 'c', priority: 3, available: 0 },
    ],
  };
  const result = runMarginCall(event, dir);
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(result.freezes, [
    { accountId: 'a', amount: 30 },
    { accountId: 'b', amount: 40 },
  ]);
  assert.deepEqual(result.rollbacks, [
    { accountId: 'b', amount: 40 },
    { accountId: 'a', amount: 30 },
  ]);
  assert.equal(result.certificate, null);
  assertNoOrphanFreezes(result);
});

// --- Acceptance: crash after any account recovers to the same result ---

test('crash after each account recovers to the crash-free result', () => {
  const accounts = [
    { id: 'a', priority: 1, available: 60 },
    { id: 'b', priority: 2, available: 0 },
    { id: 'c', priority: 3, available: 70 },
  ];
  const base = { callId: 'crash-x', targetAmount: 100, accounts };
  const expected = runMarginCall(base, tmpDir());
  for (const crashAfterAccount of [0, 1, 2]) {
    const event = { ...base, faults: { crashAfterAccount } };
    const result = runToCompletion(event, tmpDir());
    assert.deepEqual(result, expected, `crashAfterAccount=${crashAfterAccount}`);
  }
});

// --- Acceptance: cancel + crash combinations leave no orphan freezes ---

test('cancel combined with crash leaves no orphan freezes', () => {
  const accounts = [
    { id: 'a', priority: 1, available: 40 },
    { id: 'b', priority: 2, available: 40 },
    { id: 'c', priority: 3, available: 40 },
  ];
  for (const crashAfterAccount of [null, 0, 1, 2]) {
    for (const cancelAfterAccount of [-1, 0, 1]) {
      const event = {
        callId: 'cx',
        targetAmount: 100,
        accounts,
        faults: { crashAfterAccount, cancelAfterAccount },
      };
      const result = runToCompletion(event, tmpDir());
      assert.equal(result.status, 'CANCELLED', JSON.stringify(event.faults));
      assertNoOrphanFreezes(result);
    }
  }
});

// --- Acceptance: exhaustive enumeration vs brute-force model ---

test('exhaustive small combinations match the brute-force model', () => {
  const balances = [0, 40, 80];
  const crashPoints = [null, 0, 1, 2];
  const cancelPoints = [null, -1, 0, 1, 2];
  const priorityOrders = [[1, 2, 3], [3, 1, 2]];
  let cases = 0;
  for (const priorities of priorityOrders) {
    for (const b0 of balances) for (const b1 of balances) for (const b2 of balances) {
      for (const crashAfterAccount of crashPoints) {
        for (const cancelAfterAccount of cancelPoints) {
          const event = {
            callId: 'enum',
            targetAmount: 100,
            accounts: [
              { id: 'a', priority: priorities[0], available: b0 },
              { id: 'b', priority: priorities[1], available: b1 },
              { id: 'c', priority: priorities[2], available: b2 },
            ],
            faults: { crashAfterAccount, cancelAfterAccount },
          };
          const result = runToCompletion(event, tmpDir());
          const expected = bruteForce(event);
          const label = JSON.stringify({ priorities, balances: [b0, b1, b2], crashAfterAccount, cancelAfterAccount });
          assert.equal(result.status, expected.status, label);
          assert.deepEqual(result.freezes, expected.freezes, label);
          assert.deepEqual(result.rollbacks, expected.rollbacks, label);
          if (expected.status === 'CONFIRMED') {
            assert.equal(result.totalFrozen, 100, label);
            assertCertificateValid(result);
          } else {
            assertNoOrphanFreezes(result);
          }
          cases++;
        }
      }
    }
  }
  assert.equal(cases, 2 * 27 * 4 * 5);
});

// --- Idempotency ---

test('same callId is idempotent and never re-executes', () => {
  const dir = tmpDir();
  const event = {
    callId: 'idem-1',
    targetAmount: 50,
    accounts: [{ id: 'a', priority: 1, available: 100 }],
  };
  const first = runMarginCall(event, dir);
  assert.equal(first.status, 'CONFIRMED');
  // Re-run with a fault injected: a completed call must return the stored
  // result without executing anything (no crash, no double freeze).
  const second = runMarginCall({ ...event, faults: { crashAfterAccount: 0 } }, dir);
  assert.deepEqual(second, first);
  const third = runMarginCall(event, dir);
  assert.deepEqual(third, first);
});

test('reusing callId with a different event is rejected', () => {
  const dir = tmpDir();
  runMarginCall({ callId: 'c1', targetAmount: 10, accounts: [{ id: 'a', priority: 1, available: 10 }] }, dir);
  assert.throws(
    () => runMarginCall({ callId: 'c1', targetAmount: 20, accounts: [{ id: 'a', priority: 1, available: 10 }] }, dir),
    /CALL_ID_CONFLICT|different event/,
  );
});

test('zero target confirms immediately with an empty certificate freeze list', () => {
  const dir = tmpDir();
  const result = runMarginCall({ callId: 'zero', targetAmount: 0, accounts: [{ id: 'a', priority: 1, available: 5 }] }, dir);
  assert.equal(result.status, 'CONFIRMED');
  assert.deepEqual(result.freezes, []);
  assertCertificateValid(result);
});

// --- CLI ---

// Note: this sandbox swallows piped stdio of nested node processes, so the
// child's stdout/stderr are captured via files instead of pipes.
function runCli(args) {
  const captureDir = tmpDir();
  const stdoutPath = path.join(captureDir, 'stdout.txt');
  const stderrPath = path.join(captureDir, 'stderr.txt');
  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');
  let status;
  try {
    status = spawnSync(process.execPath, [CLI_PATH, ...args], { stdio: ['ignore', outFd, errFd] }).status;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return { status, stdout: fs.readFileSync(stdoutPath, 'utf8'), stderr: fs.readFileSync(stderrPath, 'utf8') };
}

test('cli: successful margin call prints JSON result on stdout', () => {
  const dir = tmpDir();
  const eventFile = path.join(dir, 'event.json');
  fs.writeFileSync(eventFile, JSON.stringify({
    callId: 'cli-1',
    targetAmount: 50,
    accounts: [{ id: 'a', priority: 1, available: 100 }],
  }));
  const res = runCli([eventFile, path.join(dir, 'logs')]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'CONFIRMED');
  assert.equal(out.callId, 'cli-1');
});

test('cli: crash injection exits 1 with error JSON, restart resumes and confirms', () => {
  const dir = tmpDir();
  const eventFile = path.join(dir, 'event.json');
  fs.writeFileSync(eventFile, JSON.stringify({
    callId: 'cli-crash',
    targetAmount: 80,
    accounts: [
      { id: 'a', priority: 1, available: 50 },
      { id: 'b', priority: 2, available: 50 },
    ],
    faults: { crashAfterAccount: 0 },
  }));
  const logDir = path.join(dir, 'logs');
  const crashed = runCli([eventFile, logDir]);
  assert.equal(crashed.status, 1);
  const errOut = JSON.parse(crashed.stderr);
  assert.equal(errOut.error, 'SIMULATED_CRASH');
  assert.equal(errOut.accountIndex, 0);
  const resumed = runCli([eventFile, logDir]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const out = JSON.parse(resumed.stdout);
  assert.equal(out.status, 'CONFIRMED');
  assert.deepEqual(out.freezes, [
    { accountId: 'a', amount: 50 },
    { accountId: 'b', amount: 30 },
  ]);
});

test('cli: invalid JSON exits 1 with standard error JSON', () => {
  const dir = tmpDir();
  const eventFile = path.join(dir, 'bad.json');
  fs.writeFileSync(eventFile, '{not json');
  const res = runCli([eventFile, path.join(dir, 'logs')]);
  assert.equal(res.status, 1);
  const errOut = JSON.parse(res.stderr);
  assert.equal(errOut.error, 'EVENT_PARSE_FAILED');
});

test('cli: invalid event exits 1 with standard error JSON', () => {
  const dir = tmpDir();
  const eventFile = path.join(dir, 'event.json');
  fs.writeFileSync(eventFile, JSON.stringify({ callId: 'x', targetAmount: -5, accounts: [] }));
  const res = runCli([eventFile, path.join(dir, 'logs')]);
  assert.equal(res.status, 1);
  const errOut = JSON.parse(res.stderr);
  assert.equal(errOut.error, 'INVALID_EVENT');
});

test('cli: missing arguments exits 1 with usage error JSON', () => {
  const res = runCli([]);
  assert.equal(res.status, 1);
  const errOut = JSON.parse(res.stderr);
  assert.equal(errOut.error, 'USAGE');
});
