import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, LedgerError } from '../src/ledger.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
}

function logLines(dir) {
  const p = path.join(dir, 'data.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Acceptance A: reversal idempotency

test('A: reverse appends a compensating entry and never mutates history', () => {
  const dir = tmpdir();
  const ledger = Ledger.open(dir);
  ledger.post('p1', 'alice', 100, { note: 'deposit' });
  const before = logLines(dir);
  const { seq } = ledger.reverse('p1', 'duplicate charge');
  const after = logLines(dir);
  assert.equal(seq, 2);
  assert.equal(after.length, 2);
  assert.equal(after[0], before[0], 'original entry line must be untouched');
  const comp = JSON.parse(after[1]);
  assert.equal(comp.type, 'reverse');
  assert.equal(comp.amount, -100);
  assert.equal(comp.reverses, 'p1');
  assert.equal(ledger.balance('alice'), 0);
  ledger.close();
});

test('A: repeating reverse of the same id is idempotent and returns the original compensation seq', () => {
  const dir = tmpdir();
  const ledger = Ledger.open(dir);
  ledger.post('p1', 'alice', 50);
  const first = ledger.reverse('p1', 'r1');
  const second = ledger.reverse('p1', 'r2');
  const third = ledger.reverse('p1', 'r3');
  assert.equal(first.seq, 2);
  assert.deepEqual(second, { seq: 2, idempotent: true });
  assert.deepEqual(third, { seq: 2, idempotent: true });
  assert.equal(ledger.committedSeq, 2, 'no extra entries appended');
  assert.equal(logLines(dir).length, 2);
  ledger.close();

  // idempotency survives restart
  const reopened = Ledger.open(dir);
  const again = reopened.reverse('p1', 'r4');
  assert.deepEqual(again, { seq: 2, idempotent: true });
  assert.equal(reopened.committedSeq, 2);
  reopened.close();
});

test('A: reverse of unknown id or settled period raises E_STATE', () => {
  const dir = tmpdir();
  const ledger = Ledger.open(dir);
  assert.throws(() => ledger.reverse('nope'), (err) => err instanceof LedgerError && err.code === 'E_STATE');
  ledger.post('p1', 'alice', 10);
  ledger.post('p2', 'alice', 20);
  ledger.settle(1);
  assert.throws(() => ledger.reverse('p1'), (err) => err.code === 'E_STATE');
  const ok = ledger.reverse('p2');
  assert.equal(ok.idempotent, false);
  assert.equal(ledger.balance('alice'), 10);
  ledger.close();

  // settled flag persists across restart
  const reopened = Ledger.open(dir);
  assert.throws(() => reopened.reverse('p1'), (err) => err.code === 'E_STATE');
  reopened.close();
});

// Acceptance B: crash injection and recovery

function crashAt(dir, hookName, crashOnSeq, seedOps) {
  let crashed;
  {
    const ledger = Ledger.open(dir);
    for (const op of seedOps) ledger.post(op.id, op.account, op.amount);
    ledger.close();
  }
  {
    const ledger = Ledger.open(dir, {
      hooks: {
        [hookName]: (entry) => {
          if (entry.seq === crashOnSeq) throw new Error(`simulated crash at ${hookName}`);
        },
      },
    });
    try {
      ledger.post('victim', 'bob', 999);
    } catch (err) {
      crashed = err;
    }
    assert.ok(crashed, 'expected simulated crash');
    // do not close cleanly: simulate process death by abandoning the instance
  }
  return Ledger.open(dir);
}

test('B: crash before fsync (after write) recovers to committed prefix only', () => {
  const dir = tmpdir();
  const seed = [
    { id: 'a', account: 'alice', amount: 10 },
    { id: 'b', account: 'alice', amount: 20 },
  ];
  const recovered = crashAt(dir, 'afterWrite', 3, seed);
  assert.equal(recovered.committedSeq, 2);
  assert.equal(recovered.balance('alice'), 30);
  assert.equal(recovered.balance('bob'), 0);
  assert.equal(logLines(dir).length, 2, 'uncommitted tail truncated from data.log');
  // ledger keeps working after recovery
  recovered.post('c', 'alice', 5);
  assert.equal(recovered.balance('alice'), 35);
  recovered.close();
});

test('B: crash after fsync but before commit marker recovers to committed prefix only', () => {
  const dir = tmpdir();
  const seed = [
    { id: 'a', account: 'alice', amount: 10 },
    { id: 'b', account: 'alice', amount: 20 },
  ];
  const recovered = crashAt(dir, 'afterFsync', 3, seed);
  assert.equal(recovered.committedSeq, 2);
  assert.equal(recovered.balance('alice'), 30);
  assert.equal(logLines(dir).length, 2, 'durable-but-uncommitted entry truncated');
  recovered.close();
});

test('B: crash on the very first entry recovers to an empty ledger', () => {
  for (const hook of ['afterWrite', 'afterFsync']) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `ledger-empty-${hook}-`));
    const ledger = Ledger.open(d, {
      hooks: { [hook]: () => { throw new Error('boom'); } },
    });
    assert.throws(() => ledger.post('x', 'alice', 1));
    const recovered = Ledger.open(d);
    assert.equal(recovered.committedSeq, 0);
    assert.equal(recovered.balance('alice'), 0);
    assert.equal(logLines(d).length, 0);
    recovered.close();
  }
});

// Acceptance C: asOfSeq vs brute-force replay

function bruteForceBalance(entries, account, asOfSeq) {
  let total = 0;
  for (let i = 0; i < asOfSeq; i += 1) {
    const e = entries[i];
    if ((e.type === 'post' || e.type === 'reverse') && e.account === account) total += e.amount;
  }
  return total;
}

test('C: balance(asOfSeq) matches brute-force replay across 200 random histories', () => {
  const rand = mulberry32(20261003);
  const accounts = ['alice', 'bob', 'carol', 'dave', 'erin'];
  for (let history = 0; history < 200; history += 1) {
    const dir = tmpdir();
    const checkpointInterval = 1 + Math.floor(rand() * 16);
    const ledger = Ledger.open(dir, { checkpointInterval });
    const opCount = 1 + Math.floor(rand() * 60);
    const posted = [];
    for (let i = 0; i < opCount; i += 1) {
      const account = accounts[Math.floor(rand() * accounts.length)];
      if (posted.length > 0 && rand() < 0.25) {
        const victim = posted[Math.floor(rand() * posted.length)];
        try {
          ledger.reverse(victim, 'random reversal');
        } catch {
          // already reversed: idempotent path, fine
        }
      } else {
        const id = `h${history}-op${i}`;
        const amount = Math.floor(rand() * 2001) - 1000;
        ledger.post(id, account, amount);
        posted.push(id);
      }
    }
    const entries = ledger.entries();
    const n = entries.length;
    const probes = new Set([0, n, Math.floor(rand() * (n + 1)), Math.floor(rand() * (n + 1))]);
    for (const asOf of probes) {
      for (const account of accounts) {
        assert.equal(
          ledger.balance(account, asOf),
          bruteForceBalance(entries, account, asOf),
          `history ${history} account ${account} asOf ${asOf}`,
        );
      }
    }
    ledger.close();
  }
});

test('C: asOfSeq queries hit checkpoint boundaries without full scans', () => {
  const dir = tmpdir();
  const ledger = Ledger.open(dir, { checkpointInterval: 4 });
  for (let i = 0; i < 1000; i += 1) ledger.post(`p${i}`, 'alice', 1);
  assert.equal(ledger.balance('alice', 1000), 1000);
  assert.equal(ledger.balance('alice', 512), 512);
  assert.equal(ledger.balance('alice', 513), 513);
  ledger.close();
});

// Acceptance D: negative balance policy

test('D: negative balance policy is configurable and rejections leave no residue', () => {
  const dir = tmpdir();
  const ledger = Ledger.open(dir, { allowNegative: false });
  ledger.post('in', 'alice', 100);
  assert.throws(
    () => ledger.post('out', 'alice', -150),
    (err) => err.code === 'E_STATE' && /negative/.test(err.message),
  );
  assert.equal(ledger.balance('alice'), 100);
  assert.equal(ledger.committedSeq, 1, 'rejected post must not occupy a seq');
  assert.equal(logLines(dir).length, 1, 'rejected post must not reach data.log');

  // reversal that would drive the account negative is also rejected cleanly
  ledger.post('spend', 'alice', -100);
  assert.equal(ledger.balance('alice'), 0);
  assert.throws(() => ledger.reverse('in'), (err) => err.code === 'E_STATE');
  assert.equal(ledger.committedSeq, 2);
  assert.equal(logLines(dir).length, 2);
  // failed reverse did not mark the id as reversed: still E_STATE, not idempotent replay
  assert.throws(() => ledger.reverse('in'), (err) => err.code === 'E_STATE');
  ledger.close();

  // recovery sees no residue either
  const reopened = Ledger.open(dir, { allowNegative: false });
  assert.equal(reopened.committedSeq, 2);
  assert.equal(reopened.balance('alice'), 0);
  reopened.close();

  // default policy allows negative balances
  const dir2 = tmpdir();
  const permissive = Ledger.open(dir2);
  permissive.post('neg', 'bob', -500);
  assert.equal(permissive.balance('bob'), -500);
  permissive.close();
});

test('D: duplicate post id raises E_STATE without residue', () => {
  const dir = tmpdir();
  const ledger = Ledger.open(dir);
  ledger.post('p1', 'alice', 10);
  assert.throws(() => ledger.post('p1', 'alice', 99), (err) => err.code === 'E_STATE');
  assert.equal(ledger.committedSeq, 1);
  assert.equal(ledger.balance('alice'), 10);
  ledger.close();
});
