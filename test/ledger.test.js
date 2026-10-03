'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Ledger, SimulatedCrashError } = require('../src/ledger');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
}

// A "session": opening a Ledger runs crash recovery, like a process restart.
function open(dir) {
  return new Ledger(dir);
}

function pay(dir, txId, from, to, amount) {
  const ledger = open(dir);
  return ledger.pay({ txId, from, to, amount });
}

function cancel(dir, txId) {
  const ledger = open(dir);
  return ledger.cancel({ txId });
}

function checkpoint(dir) {
  const ledger = open(dir);
  return ledger.checkpoint();
}

function crash(dir, point) {
  const ledger = open(dir);
  assert.throws(() => ledger.checkpoint({ crashPoint: point }), SimulatedCrashError);
  // The process "dies" here: no cleanup, no rename, object discarded.
}

// Independent enumeration: rebuild state purely from wal.log, ignoring any
// checkpoint files. This is the reference oracle for recovery correctness.
function replayWal(dir) {
  const accounts = new Map();
  const index = new Map();
  let version = 0;
  const acct = (name) => {
    if (!accounts.has(name)) {
      accounts.set(name, { balance: 0, chain: [{ version: 0, balance: 0 }] });
    }
    return accounts.get(name);
  };
  const walPath = path.join(dir, 'wal.log');
  if (fs.existsSync(walPath)) {
    for (const line of fs.readFileSync(walPath, 'utf8').split('\n').filter(Boolean)) {
      const rec = JSON.parse(line);
      version = rec.version;
      if (rec.type === 'pay') {
        const from = acct(rec.from);
        const to = acct(rec.to);
        from.balance -= rec.amount;
        to.balance += rec.amount;
        from.chain.push({ version: rec.version, balance: from.balance });
        to.chain.push({ version: rec.version, balance: to.balance });
        index.set(rec.txId, {
          txId: rec.txId,
          type: 'pay',
          from: rec.from,
          to: rec.to,
          amount: rec.amount,
          version: rec.version,
          status: 'paid',
          cancelVersion: null,
        });
      } else if (rec.type === 'cancel') {
        const tx = index.get(rec.txId);
        assert.ok(tx, `cancel of unknown tx ${rec.txId}`);
        const from = acct(tx.from);
        const to = acct(tx.to);
        from.balance += tx.amount;
        to.balance -= tx.amount;
        from.chain.push({ version: rec.version, balance: from.balance });
        to.chain.push({ version: rec.version, balance: to.balance });
        tx.status = 'cancelled';
        tx.cancelVersion = rec.version;
      } else {
        throw new Error(`bad record ${line}`);
      }
    }
  }
  const balanceAt = (name, at) => {
    const a = accounts.get(name);
    if (!a) return 0;
    let r = 0;
    for (const c of a.chain) {
      if (c.version <= at) r = c.balance;
      else break;
    }
    return r;
  };
  return { version, accounts, index, balanceAt };
}

function assertMatchesWalReplay(dir, label, { allVersions = true } = {}) {
  const expected = replayWal(dir);
  const ledger = open(dir); // triggers recovery
  assert.equal(ledger.version, expected.version, `${label}: version`);
  const names = new Set([...expected.accounts.keys(), ...ledger.accounts.keys()]);
  for (const name of names) {
    assert.equal(
      ledger.balanceAt(name),
      expected.accounts.get(name)?.balance ?? 0,
      `${label}: balance of ${name}`,
    );
  }
  assert.deepEqual(
    Object.fromEntries(ledger.txIndex),
    Object.fromEntries(expected.index),
    `${label}: tx index`,
  );
  // As-of reads at every version must match the WAL replay oracle. These
  // scenarios keep a snapshot open from version 0, so GC must retain all
  // versions and every historical read stays servable.
  if (!allVersions) return ledger;
  for (const name of expected.accounts.keys()) {
    for (let v = 0; v <= expected.version; v++) {
      assert.equal(
        ledger.balanceAt(name, v),
        expected.balanceAt(name, v),
        `${label}: balance of ${name} at v${v}`,
      );
    }
  }
  return ledger;
}

test('acceptance 1: active snapshot keeps old versions readable across checkpoint', () => {
  const dir = freshDir();
  pay(dir, 't1', 'bank', 'alice', 1000); // v1
  pay(dir, 't2', 'alice', 'bob', 300); // v2

  let ledger = open(dir);
  const snap = ledger.beginSnapshot('s1');
  assert.equal(snap.version, 2);

  pay(dir, 't3', 'alice', 'bob', 200); // v3
  checkpoint(dir);

  // Checkpoint ran GC, but the snapshot at v2 pins the old state.
  const cp = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));
  assert.equal(cp.watermark, 3);
  assert.deepEqual(
    cp.accounts.alice.versions.map((v) => [v.version, v.balance]),
    [
      [2, 700],
      [3, 500],
    ],
    'GC keeps the snapshot-visible version, drops unpinned older ones',
  );

  // After restart, old state is still servable from the checkpoint.
  ledger = open(dir);
  assert.equal(ledger.balanceAt('alice', 2), 700);
  assert.equal(ledger.balanceAt('bob', 2), 300);
  assert.equal(ledger.balanceAt('alice'), 500);

  // More history + a second checkpoint: the pinned snapshot still protects v2.
  pay(dir, 't4', 'alice', 'bob', 100); // v4
  checkpoint(dir);
  ledger = open(dir);
  assert.equal(ledger.balanceAt('alice', 2), 700);
  assert.equal(ledger.balanceAt('alice'), 400);

  // Once the snapshot ends, a further checkpoint may collect old versions.
  ledger.endSnapshot('s1');
  ledger.checkpoint();
  ledger = open(dir);
  assert.throws(() => ledger.balanceAt('alice', 2), /no retained version/);
});

for (const point of ['C1', 'C2']) {
  test(`acceptance 2: crash at ${point} recovers to exact WAL replay state`, () => {
    const dir = freshDir();
    // Snapshot from v0 pins full history so every as-of read is checkable.
    {
      const ledger = open(dir);
      ledger.beginSnapshot('guard');
    }
    pay(dir, 'p1', 'bank', 'alice', 1000); // v1
    pay(dir, 'p2', 'bank', 'bob', 500); // v2
    pay(dir, 'p3', 'alice', 'bob', 250); // v3
    checkpoint(dir); // successful checkpoint #1
    pay(dir, 'p4', 'bob', 'carol', 100); // v4
    cancel(dir, 'p2'); // v5
    pay(dir, 'p5', 'carol', 'alice', 40); // v6

    const cpBefore = fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8');
    crash(dir, point);

    // The failed checkpoint attempt must not touch the committed checkpoint.
    assert.equal(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'), cpBefore);
    assert.ok(
      fs.existsSync(path.join(dir, 'checkpoint.json.tmp')),
      'crash leaves a tmp file behind',
    );
    if (point === 'C1') {
      assert.throws(
        () => JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json.tmp'), 'utf8')),
        SyntaxError,
        'C1 leaves a half-written tmp file',
      );
    } else {
      const tmp = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json.tmp'), 'utf8'));
      assert.equal(tmp.watermark, 6, 'C2 leaves a complete but unrenamed tmp file');
    }

    // Recovery (next session) ignores and removes the tmp file.
    const ledger = open(dir);
    assert.ok(!fs.existsSync(path.join(dir, 'checkpoint.json.tmp')));
    assert.equal(ledger.balanceAt('alice'), replayWal(dir).accounts.get('alice').balance);

    // Balance, index and every as-of version query match independent replay.
    assertMatchesWalReplay(dir, `crash-${point}`);

    // Index queries agree too.
    const p2 = ledger.getTx('p2');
    assert.equal(p2.status, 'cancelled');
    assert.equal(p2.cancelVersion, 5);
    assert.deepEqual(ledger.getTx('p5'), replayWal(dir).index.get('p5'));

    // A checkpoint after recovery produces a complete, loadable file.
    checkpoint(dir);
    assertMatchesWalReplay(dir, `crash-${point}-post-checkpoint`);
  });
}

test('acceptance 3: pay-then-cancel after checkpoint reverses correctly after restart', () => {
  const dir = freshDir();
  pay(dir, 't1', 'bank', 'alice', 500); // v1
  checkpoint(dir);
  const payV = pay(dir, 't2', 'alice', 'bob', 200); // v2
  const cancelV = cancel(dir, 't2'); // v3, reverse version

  // Restart: recover from checkpoint + WAL tail.
  const ledger = open(dir);
  assert.equal(ledger.version, 3);
  assert.equal(ledger.balanceAt('alice'), 500, 'reversal restores alice');
  assert.equal(ledger.balanceAt('bob'), 0, 'reversal restores bob');
  assert.equal(ledger.balanceAt('alice', payV), 300, 'paid state visible as-of pay version');
  assert.equal(ledger.balanceAt('bob', payV), 200);
  const tx = ledger.getTx('t2');
  assert.equal(tx.status, 'cancelled');
  assert.equal(tx.cancelVersion, cancelV);

  // Cancel is itself a WAL record; replaying after restart is idempotent.
  assertMatchesWalReplay(dir, 'pay-cancel-after-checkpoint', { allVersions: false });
});

test('cancel of unpaid or unknown tx is rejected', () => {
  const dir = freshDir();
  assert.throws(() => open(dir).cancel({ txId: 'nope' }), /unknown tx/);
  pay(dir, 't1', 'a', 'b', 10);
  cancel(dir, 't1');
  assert.throws(() => open(dir).cancel({ txId: 't1' }), /not in paid state/);
  assert.throws(() => open(dir).pay({ txId: 't1', from: 'a', to: 'b', amount: 5 }), /duplicate/);
});
