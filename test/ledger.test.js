'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger, LedgerError, CrashError } = require('../src/ledger');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-ledger-'));
}

function openFunded(dir, balance = 1000) {
  const ledger = new Ledger(dir);
  ledger.transact({ key: 'open-a', op: 'open', account: 'a', amount: balance });
  return ledger;
}

// ---------------------------------------------------------------------------
// 1. Fault injection at the three defined crash points
// ---------------------------------------------------------------------------

test('crash after intent -> PENDING, retryable, never a failure', () => {
  const dir = tmpdir();
  let ledger = openFunded(dir);
  ledger.close();

  ledger = new Ledger(dir, { crashAfter: 'intent' });
  assert.throws(
    () => ledger.transact({ key: 'f1', op: 'freeze', account: 'a', amount: 400 }),
    (err) => err instanceof CrashError && err.point === 'intent',
  );

  // Recovery must succeed and report the key as PENDING, not failed.
  ledger = new Ledger(dir);
  assert.deepEqual(ledger.recoveryReport.pending, ['f1']);
  assert.deepEqual(ledger.recoveryReport.rolledBack, []);
  assert.deepEqual(ledger.pending(), ['f1']);
  // Nothing was applied.
  assert.deepEqual(ledger.balanceOf('a'), { account: 'a', balance: 1000, frozen: 0, available: 1000 });

  // Retrying the same key executes the operation exactly once.
  const result = ledger.transact({ key: 'f1', op: 'freeze', account: 'a', amount: 400 });
  assert.equal(result.status, 'committed');
  assert.equal(ledger.balanceOf('a').frozen, 400);
  assert.deepEqual(ledger.pending(), []);

  // Recovery after the retry is clean and stable.
  ledger.close();
  ledger = new Ledger(dir);
  assert.deepEqual(ledger.recoveryReport.pending, []);
  assert.equal(ledger.balanceOf('a').frozen, 400);
  ledger.close();
});

test('crash after apply (uncommitted) -> automatic rollback', () => {
  const dir = tmpdir();
  let ledger = openFunded(dir);
  ledger.close();

  ledger = new Ledger(dir, { crashAfter: 'apply' });
  assert.throws(
    () => ledger.transact({ key: 'f1', op: 'freeze', account: 'a', amount: 400 }),
    (err) => err instanceof CrashError && err.point === 'apply',
  );

  ledger = new Ledger(dir);
  assert.deepEqual(ledger.recoveryReport.rolledBack, ['f1']);
  assert.deepEqual(ledger.recoveryReport.pending, []);
  assert.deepEqual(ledger.pending(), []);
  // Rolled back: state is exactly as before the crashed transaction.
  assert.deepEqual(ledger.balanceOf('a'), { account: 'a', balance: 1000, frozen: 0, available: 1000 });

  // The key may be retried and then commits normally.
  const result = ledger.transact({ key: 'f1', op: 'freeze', account: 'a', amount: 400 });
  assert.equal(result.status, 'committed');
  assert.equal(ledger.balanceOf('a').frozen, 400);

  // Recovery remains deterministic across another restart.
  ledger.close();
  ledger = new Ledger(dir);
  assert.equal(ledger.balanceOf('a').frozen, 400);
  assert.deepEqual(ledger.recoveryReport.pending, []);
  ledger.close();
});

test('crash after commit (response lost) -> effective, replay idempotent', () => {
  const dir = tmpdir();
  let ledger = openFunded(dir);
  ledger.close();

  ledger = new Ledger(dir, { crashAfter: 'commit' });
  assert.throws(
    () => ledger.transact({ key: 'f1', op: 'freeze', account: 'a', amount: 400 }),
    (err) => err instanceof CrashError && err.point === 'commit',
  );

  ledger = new Ledger(dir);
  assert.deepEqual(ledger.recoveryReport.committed, ['open-a', 'f1']);
  assert.deepEqual(ledger.recoveryReport.pending, []);
  // The transaction is in effect even though the client never saw the response.
  assert.equal(ledger.balanceOf('a').frozen, 400);

  // Replaying the same key returns the stored result without re-applying.
  const replay = ledger.transact({ key: 'f1', op: 'freeze', account: 'a', amount: 400 });
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.frozen, 400);
  assert.equal(ledger.balanceOf('a').frozen, 400);
  ledger.close();
});

// ---------------------------------------------------------------------------
// 2. Idempotent duplicate commits
// ---------------------------------------------------------------------------

test('duplicate commit with the same key is idempotent, in-process and across restarts', () => {
  const dir = tmpdir();
  let ledger = openFunded(dir);

  const first = ledger.transact({ key: 'pay-1', op: 'freeze', account: 'a', amount: 250 });
  const second = ledger.transact({ key: 'pay-1', op: 'freeze', account: 'a', amount: 250 });
  assert.equal(first.status, 'committed');
  assert.equal(second.status, 'duplicate');
  const { status: firstStatus, ...firstBody } = first;
  const { status: secondStatus, ...secondBody } = second;
  assert.deepEqual(secondBody, firstBody);
  assert.equal(ledger.balanceOf('a').frozen, 250);

  ledger.close();
  ledger = new Ledger(dir);
  const third = ledger.transact({ key: 'pay-1', op: 'freeze', account: 'a', amount: 250 });
  assert.equal(third.status, 'duplicate');
  assert.equal(ledger.balanceOf('a').frozen, 250);
  ledger.close();
});

// ---------------------------------------------------------------------------
// 3. Reversal only affects the committed range
// ---------------------------------------------------------------------------

test('reversal compensates committed ops only', () => {
  const dir = tmpdir();
  const ledger = openFunded(dir, 1000);
  ledger.transact({ key: 'k1', op: 'freeze', account: 'a', amount: 500 });
  ledger.transact({ key: 'k2', op: 'debit', account: 'a', amount: 200 });
  ledger.transact({ key: 'k3', op: 'release', account: 'a', amount: 100 });
  // balance 800, frozen 200, available 600
  assert.deepEqual(ledger.balanceOf('a'), { account: 'a', balance: 800, frozen: 200, available: 600 });

  // Reverse the committed debit: balance and frozen grow back by 200.
  const rev = ledger.transact({ key: 'r2', op: 'reverse', target: 'k2' });
  assert.equal(rev.status, 'committed');
  assert.deepEqual(ledger.balanceOf('a'), { account: 'a', balance: 1000, frozen: 400, available: 600 });

  // Reversing k1 now would drive frozen negative -> E_INVARIANT, state untouched.
  assert.throws(
    () => ledger.transact({ key: 'r1', op: 'reverse', target: 'k1' }),
    (err) => err instanceof LedgerError && err.code === 'E_INVARIANT',
  );
  assert.deepEqual(ledger.balanceOf('a'), { account: 'a', balance: 1000, frozen: 400, available: 600 });

  // Unknown / uncommitted targets are rejected.
  assert.throws(
    () => ledger.transact({ key: 'r9', op: 'reverse', target: 'nope' }),
    (err) => err.code === 'E_INVARIANT',
  );
  // Double reversal of the same target is rejected.
  assert.throws(
    () => ledger.transact({ key: 'r2b', op: 'reverse', target: 'k2' }),
    (err) => err.code === 'E_INVARIANT',
  );

  // Reverse k3 (release) then k1 (freeze): both committed, both compensated.
  ledger.transact({ key: 'r3', op: 'reverse', target: 'k3' });
  ledger.transact({ key: 'r1', op: 'reverse', target: 'k1' });
  assert.deepEqual(ledger.balanceOf('a'), { account: 'a', balance: 1000, frozen: 0, available: 1000 });
  ledger.close();
});

test('reversal of a PENDING (recovered) key is rejected until it commits', () => {
  const dir = tmpdir();
  let ledger = openFunded(dir);
  ledger.close();

  ledger = new Ledger(dir, { crashAfter: 'intent' });
  assert.throws(() => ledger.transact({ key: 'kp', op: 'freeze', account: 'a', amount: 300 }), CrashError);

  ledger = new Ledger(dir);
  assert.deepEqual(ledger.pending(), ['kp']);
  // PENDING is not committed, so it cannot be reversed.
  assert.throws(
    () => ledger.transact({ key: 'rp', op: 'reverse', target: 'kp' }),
    (err) => err.code === 'E_INVARIANT',
  );
  // Retry commits it; only then does it enter the reversible (committed) range.
  ledger.transact({ key: 'kp', op: 'freeze', account: 'a', amount: 300 });
  ledger.transact({ key: 'rp', op: 'reverse', target: 'kp' });
  assert.equal(ledger.balanceOf('a').frozen, 0);
  ledger.close();
});

// ---------------------------------------------------------------------------
// 4. Differential test against an in-memory reference state machine
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

class Model {
  constructor() {
    this.accounts = new Map();
    this.committed = new Map();
    this.deltas = new Map();
    this.reversed = new Set();
  }

  fail(message) {
    const err = new Error(message);
    err.code = 'E_INVARIANT';
    throw err;
  }

  transact(req) {
    if (this.committed.has(req.key)) {
      return Object.assign({ status: 'duplicate' }, this.committed.get(req.key));
    }
    const delta = this.compute(req);
    this.accounts.set(delta.account, { ...delta.after });
    const acct = delta.after;
    const result = { key: req.key, op: req.op, account: delta.account, balance: acct.balance, frozen: acct.frozen, available: acct.balance - acct.frozen };
    this.committed.set(req.key, result);
    this.deltas.set(req.key, Object.assign({ op: req.op }, delta));
    if (req.op === 'reverse') this.reversed.add(req.target);
    return Object.assign({ status: 'committed' }, result);
  }

  compute(req) {
    const { op, account, amount, target } = req;
    if (op === 'open') {
      if (this.accounts.has(account)) this.fail('exists');
      return { account, before: null, after: { balance: amount, frozen: 0 } };
    }
    if (op === 'reverse') {
      const committed = this.deltas.get(target);
      if (!committed || committed.op === 'open' || this.reversed.has(target)) this.fail('not reversible');
      const cur = this.accounts.get(committed.account);
      const after = {
        balance: cur.balance + (committed.before.balance - committed.after.balance),
        frozen: cur.frozen + (committed.before.frozen - committed.after.frozen),
      };
      this.check(after);
      return { account: committed.account, before: { ...cur }, after };
    }
    const cur = this.accounts.get(account);
    if (!cur) this.fail('unknown account');
    let after;
    if (op === 'freeze') after = { balance: cur.balance, frozen: cur.frozen + amount };
    else if (op === 'debit') after = { balance: cur.balance - amount, frozen: cur.frozen - amount };
    else if (op === 'release') after = { balance: cur.balance, frozen: cur.frozen - amount };
    else this.fail('unknown op');
    this.check(after);
    return { account, before: { ...cur }, after };
  }

  check(after) {
    if (!(after.balance >= 0 && after.frozen >= 0 && after.frozen <= after.balance)) this.fail('invariant');
  }

  snapshot() {
    const out = {};
    for (const name of [...this.accounts.keys()].sort()) {
      const a = this.accounts.get(name);
      out[name] = { balance: a.balance, frozen: a.frozen, available: a.balance - a.frozen };
    }
    return out;
  }
}

test('random op sequence matches in-memory reference model, with restarts', () => {
  const dir = tmpdir();
  const rand = mulberry32(20261003);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (n) => 1 + Math.floor(rand() * n);

  let ledger = new Ledger(dir);
  const model = new Model();
  const accounts = ['a', 'b', 'c'];
  const keys = [];

  const runBoth = (req) => {
    keys.push(req.key);
    let ledgerResult;
    let ledgerError = null;
    let modelResult;
    let modelError = null;
    try {
      ledgerResult = ledger.transact(req);
    } catch (err) {
      ledgerError = err;
    }
    try {
      modelResult = model.transact(req);
    } catch (err) {
      modelError = err;
    }
    assert.equal(ledgerError === null, modelError === null, `outcome mismatch for ${JSON.stringify(req)}: ${ledgerError} vs ${modelError}`);
    if (ledgerError) assert.equal(ledgerError.code, modelError.code);
    else assert.deepEqual(ledgerResult, modelResult);
    assert.deepEqual(ledger.snapshot(), model.snapshot());
  };

  accounts.forEach((account, i) => runBoth({ key: `open-${account}`, op: 'open', account, amount: 500 + 500 * i }));

  for (let i = 0; i < 300; i += 1) {
    const roll = rand();
    let req;
    if (roll < 0.1 && keys.length > 0) {
      // duplicate key replay
      const key = pick(keys);
      req = { key, op: 'freeze', account: pick(accounts), amount: int(100) };
    } else if (roll < 0.3) {
      const candidates = [...model.deltas.keys()].filter((k) => model.deltas.get(k).op !== 'open' && !model.reversed.has(k));
      const target = candidates.length > 0 && rand() < 0.7 ? pick(candidates) : `ghost-${i}`;
      req = { key: `r${i}`, op: 'reverse', target };
    } else {
      req = { key: `k${i}`, op: pick(['freeze', 'debit', 'release']), account: pick(accounts), amount: int(200) };
    }
    runBoth(req);

    if (i % 50 === 49) {
      ledger.close();
      ledger = new Ledger(dir);
      assert.deepEqual(ledger.recoveryReport.pending, []);
      assert.deepEqual(ledger.snapshot(), model.snapshot());
    }
  }
  ledger.close();
});

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

test('corrupt WAL -> E_RECOVER', () => {
  const dir = tmpdir();
  const ledger = openFunded(dir);
  ledger.close();
  fs.appendFileSync(path.join(dir, 'wal.log'), 'this is not json\n');
  assert.throws(() => new Ledger(dir), (err) => err instanceof LedgerError && err.code === 'E_RECOVER');
});

test('unusable directory -> E_IO', () => {
  const dir = tmpdir();
  const filePath = path.join(dir, 'a-file');
  fs.writeFileSync(filePath, 'x');
  assert.throws(
    () => new Ledger(path.join(filePath, 'sub')),
    (err) => err instanceof LedgerError && err.code === 'E_IO',
  );
});

test('invariant violations -> E_INVARIANT and no WAL garbage', () => {
  const dir = tmpdir();
  const ledger = openFunded(dir, 100);
  assert.throws(() => ledger.transact({ key: 'x1', op: 'freeze', account: 'a', amount: 101 }), (err) => err.code === 'E_INVARIANT');
  assert.throws(() => ledger.transact({ key: 'x2', op: 'debit', account: 'a', amount: 1 }), (err) => err.code === 'E_INVARIANT');
  assert.throws(() => ledger.transact({ key: 'x3', op: 'freeze', account: 'ghost', amount: 1 }), (err) => err.code === 'E_INVARIANT');
  assert.throws(() => ledger.transact({ key: 'x4', op: 'freeze', account: 'a', amount: -5 }), (err) => err.code === 'E_INVARIANT');
  // Rejected before any intent was written: recovery stays clean.
  ledger.close();
  const reopened = new Ledger(dir);
  assert.deepEqual(reopened.recoveryReport.pending, []);
  assert.equal(reopened.balanceOf('a').available, 100);
  reopened.close();
});
