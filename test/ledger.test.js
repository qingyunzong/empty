'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {
  Ledger,
  verifyFile,
  buildView,
  makeProof,
  verifyProof,
  GENESIS_PREV_HASH,
} = require('../lib/ledger');
const { tmpdir } = require('./util');

const T0 = 1_700_000_000_000;

function freshLedger() {
  const dir = tmpdir('ledger-unit-');
  const logPath = path.join(dir, 'ledger.log');
  return { dir, logPath, ledger: Ledger.create(logPath) };
}

test('append builds a hash-chained log and verify passes', () => {
  const { logPath, ledger } = freshLedger();
  const e1 = ledger.append({ type: 'post', account: 'A', amount: 100, bizKey: 'k1' }, { ts: T0, bizTime: T0 });
  const e2 = ledger.append({ type: 'post', account: 'B', amount: -40, bizKey: 'k2' }, { ts: T0 + 1000, bizTime: T0 + 900 });
  assert.equal(e1.prevHash, GENESIS_PREV_HASH);
  assert.equal(e2.prevHash, e1.hash);
  const res = verifyFile(logPath, { now: T0 + 2000 });
  assert.equal(res.ok, true);
  assert.equal(res.entries, 2);
  assert.equal(res.head, e2.hash);
});

test('correction must point at an existing entry', () => {
  const { ledger } = freshLedger();
  assert.throws(
    () => ledger.append({ type: 'correct', account: 'A', amount: 1, supersedes: 'f'.repeat(64) }, { ts: T0 }),
    /supersedes target not found/
  );
});

test('corrections apply by business time; view reflects the winner', () => {
  const { logPath, ledger } = freshLedger();
  const p = ledger.append({ type: 'post', account: 'A', amount: 100, bizKey: 'k1' }, { ts: T0, bizTime: T0 });
  ledger.append({ type: 'correct', account: 'A', amount: 80, supersedes: p.hash }, { ts: T0 + 1000, bizTime: T0 + 10 });
  const c2 = ledger.append({ type: 'correct', account: 'A', amount: 120, supersedes: p.hash }, { ts: T0 + 2000, bizTime: T0 + 20 });
  const view = buildView(ledger.entries);
  assert.equal(view.accounts.A.balance, 120); // highest bizTime wins
  assert.deepEqual(view.accounts.A.effective, [c2.hash]);
  assert.equal(view.accounts.A.conflicts.length, 0);
  assert.equal(verifyFile(logPath, { now: T0 + 3000 }).ok, true);
});

test('concurrent corrections on the same business key keep a conflict certificate', () => {
  const { ledger } = freshLedger();
  const p = ledger.append({ type: 'post', account: 'A', amount: 100, bizKey: 'k1' }, { ts: T0, bizTime: T0 });
  const c1 = ledger.append({ type: 'correct', account: 'A', amount: 80, supersedes: p.hash }, { ts: T0 + 1000, bizTime: T0 + 50 });
  const c2 = ledger.append({ type: 'correct', account: 'A', amount: 90, supersedes: p.hash }, { ts: T0 + 2000, bizTime: T0 + 50 });
  const view = buildView(ledger.entries);
  assert.equal(view.accounts.A.conflicts.length, 1);
  const cert = view.accounts.A.conflicts[0];
  assert.equal(cert.type, 'concurrent-correction');
  assert.equal(cert.bizKey, 'k1');
  assert.deepEqual(cert.candidates, [c1.hash, c2.hash].sort());
  assert.equal(cert.winner, c1.hash); // deterministic: earlier seq wins the tie
  assert.equal(view.accounts.A.balance, 80);
});

test('tombstone deletes on-chain entry from the current view but stays in the log', () => {
  const { logPath, ledger } = freshLedger();
  const p = ledger.append({ type: 'post', account: 'A', amount: 100, bizKey: 'k1' }, { ts: T0, bizTime: T0 });
  const tomb = ledger.append({ type: 'tombstone', account: 'A', supersedes: p.hash }, { ts: T0 + 1000, bizTime: T0 + 5 });
  const view = buildView(ledger.entries);
  assert.equal(view.accounts.A.balance, 0);
  assert.deepEqual(view.accounts.A.effective, []);
  assert.deepEqual(view.accounts.A.tombstoned, [tomb.hash]);
  assert.equal(ledger.entries.length, 2); // old evidence retained
  assert.equal(verifyFile(logPath, { now: T0 + 2000 }).ok, true);
});

test('correction chained after a tombstone can revive the business key', () => {
  const { ledger } = freshLedger();
  const p = ledger.append({ type: 'post', account: 'A', amount: 100, bizKey: 'k1' }, { ts: T0, bizTime: T0 });
  const tomb = ledger.append({ type: 'tombstone', account: 'A', supersedes: p.hash }, { ts: T0 + 1000, bizTime: T0 + 5 });
  const fix = ledger.append({ type: 'correct', account: 'A', amount: 60, supersedes: tomb.hash }, { ts: T0 + 2000, bizTime: T0 + 9 });
  const view = buildView(ledger.entries);
  assert.equal(view.accounts.A.balance, 60);
  assert.deepEqual(view.accounts.A.effective, [fix.hash]);
});

test('verify rejects non-monotonic timestamps and future entries', () => {
  const { logPath, ledger } = freshLedger();
  ledger.append({ type: 'post', account: 'A', amount: 1, bizKey: 'k1' }, { ts: T0 + 5000, bizTime: T0 });
  ledger.append({ type: 'post', account: 'A', amount: 1, bizKey: 'k2' }, { ts: T0 + 4000, bizTime: T0 }); // goes backwards
  let res = verifyFile(logPath, { now: T0 + 9000 });
  assert.equal(res.ok, false);
  assert.equal(res.seq, 1);
  assert.match(res.reason, /time-not-monotonic/);

  const f = freshLedger();
  f.ledger.append({ type: 'post', account: 'A', amount: 1, bizKey: 'k1' }, { ts: T0 + 10 ** 9, bizTime: T0 });
  res = verifyFile(f.logPath, { now: T0 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /time-in-future/);
});

test('verify rejects unknown supersedes and bad hashes without truncating the log', () => {
  const { logPath, ledger } = freshLedger();
  ledger.append({ type: 'post', account: 'A', amount: 1, bizKey: 'k1' }, { ts: T0, bizTime: T0 });
  ledger.append({ type: 'post', account: 'A', amount: 2, bizKey: 'k2' }, { ts: T0 + 1000, bizTime: T0 });
  const sizeBefore = fs.statSync(logPath).size;

  // flip a byte inside the first entry line
  const buf = fs.readFileSync(logPath);
  buf[40] = buf[40] === 0x61 ? 0x62 : 0x61;
  fs.writeFileSync(logPath, buf);

  const res = verifyFile(logPath, { now: T0 + 2000 });
  assert.equal(res.ok, false);
  assert.equal(res.seq, 0);
  assert.equal(res.offset, 0);
  assert.match(res.reason, /hash-mismatch|parse-error/);
  assert.equal(fs.statSync(logPath).size, sizeBefore); // log not truncated
});

test('proof contains chain path and correction ancestors; verify-proof recomputes', () => {
  const { ledger } = freshLedger();
  const p = ledger.append({ type: 'post', account: 'A', amount: 100, bizKey: 'k1' }, { ts: T0, bizTime: T0 });
  const c1 = ledger.append({ type: 'correct', account: 'A', amount: 80, supersedes: p.hash }, { ts: T0 + 1000, bizTime: T0 + 10 });
  ledger.append({ type: 'post', account: 'B', amount: 5, bizKey: 'k9' }, { ts: T0 + 2000, bizTime: T0 + 2000 });
  const c2 = ledger.append({ type: 'correct', account: 'A', amount: 70, supersedes: c1.hash }, { ts: T0 + 3000, bizTime: T0 + 20 });

  const proof = makeProof(ledger.entries, 'A');
  assert.equal(proof.entries.length, 3);
  assert.deepEqual(proof.correctionAncestors[c2.hash], [c1.hash, p.hash]);
  assert.equal(proof.chain.length, 4); // full hash-chain path up to head

  const res = verifyProof(proof, ledger.key, { headHash: ledger.head.hash });
  assert.equal(res.ok, true);

  // tamper with the proof: change an amount without fixing the hash
  const bad = JSON.parse(JSON.stringify(proof));
  bad.entries[1].op.amount = 999999;
  assert.equal(verifyProof(bad, ledger.key).ok, false);

  // wrong key cannot validate
  const crypto = require('node:crypto');
  assert.equal(verifyProof(proof, crypto.randomBytes(32)).ok, false);
});
