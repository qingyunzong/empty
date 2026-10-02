import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ledger, CHECKPOINT_INTERVAL } from '../src/ledger.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
}

function logLines(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'data.log'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Independent brute-force replay straight from data.log.
function bruteForceBalance(dir, account, asOfSeq) {
  let bal = 0;
  for (const line of logLines(dir)) {
    const e = JSON.parse(line);
    if (e.seq > asOfSeq) continue;
    if ((e.type === 'post' || e.type === 'reverse') && e.account === account) bal += e.amount;
  }
  return bal;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The sandbox drops piped stdio of spawned children, so capture via files.
function runCli(args) {
  const outPath = path.join(os.tmpdir(), `cli-out-${process.pid}-${Math.random()}.txt`);
  const errPath = path.join(os.tmpdir(), `cli-err-${process.pid}-${Math.random()}.txt`);
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const res = spawnSync('node', [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  if (res.error && res.status === null) throw res.error;
  return {
    status: res.status,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

test('A: reverse is idempotent and only appends one compensation entry', () => {
  const dir = tmpdir();
  const l = new Ledger(dir);
  const s1 = l.post('p1', 'alice', 100);
  l.post('p2', 'alice', 40);
  const c1 = l.reverse('p1', 'duplicate charge');
  const linesBefore = logLines(dir).length;
  const c2 = l.reverse('p1', 'duplicate charge');
  const c3 = l.reverse('p1');
  assert.equal(c1, c2);
  assert.equal(c2, c3);
  assert.equal(logLines(dir).length, linesBefore, 'no extra entry appended on repeat reverse');
  assert.equal(l.balance('alice'), 40);
  // compensation entry is a proper appended entry, history untouched
  const comp = JSON.parse(logLines(dir)[c1 - 1]);
  assert.equal(comp.type, 'reverse');
  assert.equal(comp.refId, 'p1');
  assert.equal(comp.amount, -100);
  assert.equal(JSON.parse(logLines(dir)[s1 - 1]).amount, 100, 'original entry unchanged');
  // persistence: fresh instance agrees
  const l2 = new Ledger(dir);
  assert.equal(l2.reverse('p1'), c1);
  assert.equal(l2.balance('alice'), 40);
});

test('A: reverse of unknown id or settled period raises E_STATE', () => {
  const dir = tmpdir();
  const l = new Ledger(dir);
  l.post('p1', 'alice', 100);
  assert.throws(() => l.reverse('nope'), { code: 'E_STATE' });
  l.post('p2', 'alice', 10);
  l.settle(1); // period up to seq 1 is interest-settled
  assert.throws(() => l.reverse('p1'), { code: 'E_STATE' });
  assert.equal(typeof l.reverse('p2'), 'number', 'entry outside settled period still reversible');
});

test('B: crash before fsync and after fsync both recover to committed prefix', () => {
  for (const point of ['afterWrite', 'afterFsync', 'afterCommit']) {
    const dir = tmpdir();
    const l = new Ledger(dir);
    l.post('ok1', 'alice', 100);
    l.post('ok2', 'bob', 7);
    l.hooks = {
      [point]() {
        throw new Error('simulated crash');
      },
    };
    assert.throws(() => l.post('lost', 'alice', 999), { message: 'simulated crash' });

    const recovered = new Ledger(dir);
    const committed = point === 'afterCommit' ? 3 : 2;
    assert.equal(recovered.lastSeq, committed, `crash at ${point}`);
    assert.equal(recovered.balance('alice'), point === 'afterCommit' ? 1099 : 100);
    assert.equal(recovered.balance('bob'), 7);
    assert.equal(logLines(dir).length, committed, 'uncommitted tail truncated');

    // seq allocation continues correctly after recovery
    const next = recovered.post('after-crash', 'bob', 1);
    assert.equal(next, committed + 1);
    const again = new Ledger(dir);
    assert.equal(again.lastSeq, committed + 1);
    assert.equal(again.balance('bob'), 8);
  }
});

test('B: recovery result equals committed prefix even with torn tail bytes', () => {
  const dir = tmpdir();
  const l = new Ledger(dir);
  l.post('a', 'alice', 5);
  l.post('b', 'alice', 6);
  // simulate a torn write: garbage bytes appended without a commit marker
  fs.appendFileSync(path.join(dir, 'data.log'), '{"seq":3,"type":"post","id":"c","acc');
  const r = new Ledger(dir);
  assert.equal(r.lastSeq, 2);
  assert.equal(r.balance('alice'), 11);
  assert.equal(logLines(dir).length, 2);
});

test('C: balance(asOfSeq) matches brute-force replay across 200 random histories', () => {
  const rand = mulberry32(20261003);
  const accounts = ['alice', 'bob', 'carol', 'dave'];
  for (let h = 0; h < 200; h++) {
    const dir = tmpdir();
    const l = new Ledger(dir);
    const ids = [];
    const ops = 1 + Math.floor(rand() * 150);
    for (let i = 0; i < ops; i++) {
      const roll = rand();
      if (roll < 0.7 || ids.length === 0) {
        const id = `h${h}-p${i}`;
        l.post(id, accounts[Math.floor(rand() * accounts.length)], Math.floor(rand() * 2000) - 500);
        ids.push(id);
      } else if (roll < 0.9) {
        const id = ids[Math.floor(rand() * ids.length)];
        try {
          l.reverse(id, 'rnd'); // repeat reverses exercise idempotency
        } catch (e) {
          assert.equal(e.code, 'E_STATE'); // already-settled period
        }
      } else if (l.lastSeq > 0) {
        try {
          l.settle(1 + Math.floor(rand() * l.lastSeq));
        } catch (e) {
          assert.equal(e.code, 'E_STATE');
        }
      }
    }
    for (let q = 0; q < 10; q++) {
      const asOf = Math.floor(rand() * (l.lastSeq + 1));
      const acc = accounts[Math.floor(rand() * accounts.length)];
      assert.equal(l.balance(acc, asOf), bruteForceBalance(dir, acc, asOf), `history ${h} seq ${asOf}`);
      assert.ok(
        l.stats.scanned <= CHECKPOINT_INTERVAL,
        `scanned ${l.stats.scanned} entries, sparse index must bound scans to ${CHECKPOINT_INTERVAL}`,
      );
    }
    // spot-check idempotency invariants on random histories
    for (const id of ids.slice(0, 3)) {
      try {
        l.reverse(id);
      } catch (e) {
        assert.equal(e.code, 'E_STATE');
      }
      const before = logLines(dir).length;
      try {
        l.reverse(id); // second reverse must never append
      } catch (e) {
        assert.equal(e.code, 'E_STATE');
      }
      assert.equal(logLines(dir).length, before);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('C: sparse index never scans the full log even for old asOfSeq', () => {
  const dir = tmpdir();
  const l = new Ledger(dir);
  for (let i = 0; i < 500; i++) l.post(`p${i}`, 'alice', 1);
  l.balance('alice', 500);
  assert.ok(l.stats.scanned <= CHECKPOINT_INTERVAL);
  l.balance('alice', 130);
  assert.ok(l.stats.scanned <= CHECKPOINT_INTERVAL);
  assert.equal(l.balance('alice', 500), 500);
  assert.equal(l.balance('alice', 130), 130);
});

test('D: configurable negative-balance policy, failures leave no residue', () => {
  const dir = tmpdir();
  const l = new Ledger(dir, { allowNegative: false });
  l.post('p1', 'alice', 100);
  assert.throws(() => l.post('p2', 'alice', -150), { code: 'E_POLICY' });
  assert.equal(l.balance('alice'), 100, 'balance unchanged after rejected post');
  assert.equal(logLines(dir).length, 1, 'no entry appended for rejected post');
  assert.equal(l.lastSeq, 1);
  // reversal that would drive the account negative is also rejected
  l.post('p3', 'alice', -60);
  assert.throws(() => l.reverse('p1'), { code: 'E_POLICY' });
  assert.equal(l.balance('alice'), 40);
  // state machine still healthy: seq allocation has no gaps
  assert.equal(l.post('p4', 'alice', 10), 3);
  assert.equal(l.balance('alice'), 50);
  // persisted state identical to in-memory state
  const r = new Ledger(dir, { allowNegative: false });
  assert.equal(r.lastSeq, 3);
  assert.equal(r.balance('alice'), 50);
  // default policy allows negative balances
  const dir2 = tmpdir();
  const l2 = new Ledger(dir2);
  l2.post('x', 'bob', -5);
  assert.equal(l2.balance('bob'), -5);
});

test('CLI: apply + balance, errors exit non-zero with {code,message} on stderr', () => {
  const dir = tmpdir();
  const opsFile = path.join(dir, 'ops.jsonl');
  fs.writeFileSync(
    opsFile,
    ['{"op":"post","id":"p1","account":"alice","amount":100}',
     '{"op":"post","id":"p2","account":"alice","amount":-30}',
     '{"op":"reverse","id":"p1","reason":"refund"}',
     ''].join('\n'),
  );
  const applyRes = runCli(['--dir', dir, 'apply', opsFile]);
  assert.equal(applyRes.status, 0, applyRes.stderr);
  const seqs = applyRes.stdout.trim().split('\n').map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, [1, 2, 3]);

  const balRes = runCli(['--dir', dir, 'balance', 'alice']);
  assert.equal(balRes.status, 0, balRes.stderr);
  assert.equal(JSON.parse(balRes.stdout).balance, -30);
  const asOfRes = runCli(['--dir', dir, 'balance', 'alice', '--as-of', '1']);
  assert.equal(JSON.parse(asOfRes.stdout).balance, 100);

  const badFile = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(badFile, '{"op":"reverse","id":"ghost"}\n');
  const res = runCli(['--dir', dir, 'apply', badFile]);
  assert.notEqual(res.status, 0);
  const errObj = JSON.parse(res.stderr.trim());
  assert.equal(errObj.code, 'E_STATE');
  assert.equal(typeof errObj.message, 'string');

  const res2 = runCli(['--dir', dir, 'balance', 'alice', '--as-of', '999']);
  assert.notEqual(res2.status, 0);
  assert.equal(JSON.parse(res2.stderr.trim()).code, 'E_STATE');
});
