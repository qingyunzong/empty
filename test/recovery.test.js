import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rev.js');

function rev(args, env = {}, cwd = null) {
  // NOTE: this sandbox cannot capture piped child stdio, so output is
  // captured through temporary files instead.
  const dir = cwd ?? process.cwd();
  const outPath = path.join(dir, `.rev-out-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const errPath = outPath + '.err';
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, ...env },
    cwd: dir,
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  r.stdout = fs.readFileSync(outPath, 'utf8');
  r.stderr = fs.readFileSync(errPath, 'utf8');
  fs.unlinkSync(outPath);
  fs.unlinkSync(errPath);
  return r;
}

const PLAN = `
param reason = "ops-review";
for t in [txn:1001, txn:1002, txn:1003] {
  if t.status == SETTLED { reverse t; }
  else if t.status == PENDING { cancel t; }
}
move 1.25 from acc:revenue.fees to acc:cash.operating;
`;

const LEDGER = {
  currentDay: 3,
  accounts: { 'cash.operating': {}, 'revenue.fees': {} },
  txns: [
    { id: '1001', status: 'SETTLED', day: 3, entries: [
      { account: 'cash.operating', debit: 12500, credit: 0 },
      { account: 'revenue.fees', debit: 0, credit: 12500 } ] },
    { id: '1002', status: 'SETTLED', day: 1, entries: [
      { account: 'cash.operating', debit: 8000, credit: 0 },
      { account: 'revenue.fees', debit: 0, credit: 8000 } ] },
    { id: '1003', status: 'PENDING', day: 3, entries: [] },
  ],
};

function setup(dir) {
  fs.writeFileSync(path.join(dir, 'plan.rvx'), PLAN);
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(LEDGER, null, 2));
}

function walRecords(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('crash after SAVEPOINT at every effect index recovers to the no-crash reference', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-rec-'));
  setup(dir);

  // Reference: crash-free run.
  const ref = rev(['run', 'plan.rvx', 'ledger.json', '--wal', 'ref.wal', '--out', 'ref.json'], {}, dir);
  assert.equal(ref.status, 0, ref.stderr);
  const reference = JSON.parse(fs.readFileSync(path.join(dir, 'ref.json'), 'utf8'));

  const effectCount = walRecords(dir, 'ref.wal').filter((r) => r.type === 'effect').length;
  assert.equal(effectCount, 4); // 2 reversals + 1 cancel + 1 move

  // WAL logs every bytecode before execution and brackets units with SAVEPOINT/COMMIT.
  const ops = walRecords(dir, 'ref.wal').filter((r) => r.type === 'pc').map((r) => r.op);
  assert.ok(ops.includes('SAVEPOINT') && ops.includes('COMMIT') && ops.includes('LOCK_CHECK'));

  // Enumerate every crash point: crash right after the k-th effect is WAL-logged.
  for (let k = 1; k <= effectCount; k++) {
    const wal = `crash${k}.wal`;
    const crashed = rev(
      ['run', 'plan.rvx', 'ledger.json', '--wal', wal, '--out', `crash${k}.json`],
      { REV_CRASH_AT_EFFECT: String(k) },
      dir,
    );
    assert.equal(crashed.status, 3, `crash run k=${k} should exit 3, got ${crashed.status}: ${crashed.stderr}`);
    assert.ok(!fs.existsSync(path.join(dir, `crash${k}.json`)), 'ledger must not be written on crash');

    const recovered = rev(['recover', '--wal', wal], {}, dir);
    assert.equal(recovered.status, 0, recovered.stderr);
    const got = JSON.parse(fs.readFileSync(path.join(dir, `crash${k}.json`), 'utf8'));
    assert.deepEqual(got, reference, `recovered state at crash point ${k} differs from reference`);
  }
});

test('re-submitting the same reversal never double-posts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-dup-'));
  setup(dir);

  const first = rev(['run', 'plan.rvx', 'ledger.json', '--wal', 'a.wal'], {}, dir);
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8');

  // Same WAL: committed run is an idempotent no-op.
  const again = rev(['run', 'plan.rvx', 'ledger.json', '--wal', 'a.wal'], {}, dir);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /idempotent/);
  assert.equal(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'), afterFirst);

  // Fresh WAL, same plan: the deterministic idempotency key of the move
  // blocks the duplicate submission; the ledger is untouched.
  const dup = rev(['run', 'plan.rvx', 'ledger.json', '--wal', 'b.wal'], {}, dir);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /error\[E_DUP\] pc=\d+: effect 'mov:\d+' already applied/);
  assert.equal(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'), afterFirst);

  // Fresh WAL, unconditional reversal of an already-REVERSED txn: the
  // idempotency guard rejects the duplicate with E_DUP (txnId + pc attached).
  fs.writeFileSync(path.join(dir, 'blind.rvx'), 'reverse txn:1001;\n');
  const blind = rev(['run', 'blind.rvx', 'ledger.json', '--wal', 'c.wal'], {}, dir);
  assert.equal(blind.status, 1);
  assert.match(blind.stderr, /error\[E_DUP\] txn=1001 pc=\d+/);
  assert.equal(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'), afterFirst);

  // Balances prove nothing was reversed twice.
  const ledger = JSON.parse(afterFirst);
  const bal = {};
  for (const t of ledger.txns) for (const e of t.entries || []) {
    bal[e.account] = (bal[e.account] || 0) + (e.debit || 0) - (e.credit || 0);
  }
  assert.equal(bal['cash.operating'], 125);
  assert.equal(bal['revenue.fees'], -125);
});

test('recover is itself idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-rec2-'));
  setup(dir);
  const crashed = rev(['run', 'plan.rvx', 'ledger.json', '--wal', 'c.wal', '--out', 'c.json'],
    { REV_CRASH_AT_EFFECT: '1' }, dir);
  assert.equal(crashed.status, 3);
  assert.equal(rev(['recover', '--wal', 'c.wal'], {}, dir).status, 0);
  const once = fs.readFileSync(path.join(dir, 'c.json'), 'utf8');
  assert.equal(rev(['recover', '--wal', 'c.wal'], {}, dir).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'c.json'), 'utf8'), once);
});

test('E_IO: missing wal and unreadable ledger are reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-io-'));
  setup(dir);
  const noWal = rev(['recover', '--wal', 'nope.wal'], {}, dir);
  assert.equal(noWal.status, 1);
  assert.match(noWal.stderr, /error\[E_IO\]/);
  const noLedger = rev(['run', 'plan.rvx', 'nope.json', '--wal', 'x.wal'], {}, dir);
  assert.equal(noLedger.status, 1);
  assert.match(noLedger.stderr, /error\[E_IO\]/);
});
