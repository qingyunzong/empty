import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/commands.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-store-'));
}

function run(args) {
  const { out, code } = runCommand(args);
  return { code, out, err: code !== 0 ? out?.error?.message : '' };
}

const ev = (type, account, tx, amount, extra = {}) => JSON.stringify({ type, account, tx, amount, ...extra });

// Independent reference fold used to enumerate expected balances/fees.
function referenceState(events) {
  const accounts = {};
  const fees = {};
  const byTx = new Map();
  const cancelled = new Set();
  for (const e of events) {
    const bal = accounts[e.account] ?? 0;
    if (e.type === 'deposit') accounts[e.account] = bal + e.amount;
    else if (e.type === 'refund') accounts[e.account] = bal - e.amount;
    else if (e.type === 'fee') { accounts[e.account] = bal - e.amount; fees[e.account] = (fees[e.account] ?? 0) + e.amount; }
    else if (e.type === 'cancel') {
      const orig = byTx.get(e.ref);
      if (orig.type === 'deposit') accounts[e.account] = bal - orig.amount;
      else if (orig.type === 'refund') accounts[e.account] = bal + orig.amount;
      else if (orig.type === 'fee') { accounts[e.account] = bal + orig.amount; fees[e.account] -= orig.amount; }
      cancelled.add(e.ref);
    }
    byTx.set(e.tx, e);
  }
  return { accounts, fees, byTx, cancelled };
}

test('small event stream: audit state and find queries match enumerated balances/fees', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'data.bin');

  const batch1 = [
    { type: 'deposit', account: 'alice', tx: 't1', amount: 100 },
    { type: 'deposit', account: 'bob', tx: 't2', amount: 50 },
  ];
  const batch2 = [
    { type: 'fee', account: 'alice', tx: 't3', amount: 10 },
    { type: 'refund', account: 'alice', tx: 't4', amount: 30 },
    { type: 'deposit', account: 'alice', tx: 't5', amount: 20 },
  ];
  const batch3 = [{ type: 'deposit', account: 'carol', tx: 't6', amount: 7 }];

  for (const batch of [batch1, batch2, batch3]) {
    const r = run(['append', f, ...batch.flatMap((e) => ['--event', JSON.stringify(e)])]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.ok, true);
  }
  const cancel = run(['cancel', f, '--tx', 't2']);
  assert.equal(cancel.code, 0, cancel.err);
  assert.equal(cancel.out.event.ref, 't2');
  assert.equal(cancel.out.event.account, 'bob');
  assert.equal(cancel.out.event.amount, 50);

  const all = [...batch1, ...batch2, ...batch3, cancel.out.event];
  const expected = referenceState(all);

  // Audit path: enumerated net balances and fees must match.
  const audit = run(['audit', f]);
  assert.equal(audit.code, 0, audit.err);
  assert.equal(audit.out.ok, true);
  assert.equal(audit.out.chunks.confirmed.length, 4);
  assert.deepEqual(audit.out.state.accounts, expected.accounts);
  assert.deepEqual(audit.out.state.fees.byAccount, expected.fees);
  assert.equal(audit.out.state.fees.total, Object.values(expected.fees).reduce((a, b) => a + b, 0));

  // Query path: every account's events via index must match the stream.
  for (const account of Object.keys(expected.accounts)) {
    const r = run(['find', f, '--account', account]);
    assert.equal(r.code, 0, r.err);
    const want = all.filter((e) => e.account === account);
    assert.deepEqual(r.out.matches.map((m) => m.event), want);
  }
  // Every tx resolves to exactly its own event.
  for (const e of all) {
    const r = run(['find', f, '--tx', e.tx]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.matches.length, 1);
    assert.deepEqual(r.out.matches[0].event, e);
  }
});

test('corrupted middle chunk: quarantine point, pending chunks, frozen state', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'data.bin');

  const mk = (n) => [
    { type: 'deposit', account: `acc${n}`, tx: `tx${n}a`, amount: 40 },
    { type: 'refund', account: `acc${n}`, tx: `tx${n}b`, amount: 5 },
  ];
  for (const batch of [mk(0), mk(1), mk(2)]) {
    const r = run(['append', f, ...batch.flatMap((e) => ['--event', JSON.stringify(e)])]);
    assert.equal(r.code, 0, r.err);
  }

  const before = run(['audit', f]);
  const chunk1 = before.out.chunks.confirmed[1];

  // Flip a byte inside chunk 1's payload.
  const fd = fs.openSync(f, 'r+');
  const pos = chunk1.offset + 64 + 3;
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, pos);
  one[0] ^= 0xff;
  fs.writeSync(fd, one, 0, 1, pos);
  fs.closeSync(fd);

  const audit = run(['audit', f]);
  assert.equal(audit.code, 2);
  assert.equal(audit.out.ok, false);
  assert.deepEqual(audit.out.chunks.quarantined.map((c) => c.index), [1]);
  assert.deepEqual(audit.out.chunks.pending.map((c) => c.index), [2]);
  // State frozen at confirmed prefix: only chunk 0 events applied.
  const expected = referenceState(mk(0));
  assert.deepEqual(audit.out.state.accounts, expected.accounts);
  assert.deepEqual(audit.out.state.fees.byAccount, expected.fees);

  // Quarantine command reports the same manifest and exits 2.
  const q = run(['quarantine', f]);
  assert.equal(q.code, 2);
  assert.deepEqual(q.out.quarantined.map((c) => c.index), [1]);
  assert.deepEqual(q.out.pending.map((c) => c.index), [2]);
  const manifest = JSON.parse(fs.readFileSync(`${f}.quarantine.json`, 'utf8'));
  assert.equal(manifest.quarantinePoint, 1);

  // find --tx still answers from a confirmed chunk without touching bad chunks.
  const hit = run(['find', f, '--tx', 'tx0a']);
  assert.equal(hit.code, 0, hit.err);
  assert.equal(hit.out.matches[0].event.tx, 'tx0a');
  // find --tx into the quarantined chunk is a corruption error.
  const bad = run(['find', f, '--tx', 'tx1a']);
  assert.equal(bad.code, 2);

  // Appending to a broken chain is refused with exit 2.
  const app = run(['append', f, '--event', ev('deposit', 'x', 'txx', 1)]);
  assert.equal(app.code, 2);
});

test('zero-padded tail: rebuild truncates, restart recovers, repeat is idempotent', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'data.bin');

  const batch = [
    { type: 'deposit', account: 'a', tx: 't1', amount: 100 },
    { type: 'fee', account: 'a', tx: 't2', amount: 4 },
  ];
  assert.equal(run(['append', f, ...batch.flatMap((e) => ['--event', JSON.stringify(e)])]).code, 0);
  const sizeBefore = fs.statSync(f).size;

  // Simulate a crashed pre-allocation: zero padding after the last chunk.
  fs.appendFileSync(f, Buffer.alloc(200));
  assert.equal(fs.statSync(f).size, sizeBefore + 200);

  const r1 = run(['rebuild', f]);
  assert.equal(r1.code, 0, r1.err);
  assert.equal(r1.out.ok, true);
  assert.equal(r1.out.truncated, 1);
  assert.equal(fs.statSync(f).size, sizeBefore);

  // Idempotent: a second rebuild truncates nothing and reports the same state.
  const r2 = run(['rebuild', f]);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(r2.out.truncated, 0);
  assert.deepEqual(r2.out.quarantined, []);

  // After "restart", audit and queries still work.
  const audit = run(['audit', f]);
  assert.equal(audit.code, 0);
  assert.deepEqual(audit.out.state.accounts, { a: 96 });
  assert.equal(audit.out.state.fees.total, 4);
  const find = run(['find', f, '--tx', 't2']);
  assert.equal(find.code, 0);
  assert.equal(find.out.matches[0].event.amount, 4);

  // Appends after recovery continue the chain cleanly.
  const app = run(['append', f, '--event', ev('deposit', 'a', 't3', 10)]);
  assert.equal(app.code, 0, app.err);
  const audit2 = run(['audit', f]);
  assert.equal(audit2.code, 0);
  assert.deepEqual(audit2.out.state.accounts, { a: 106 });
});

test('business errors exit 1: negative refund, unknown/duplicate cancel, duplicate tx', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'data.bin');

  assert.equal(run(['append', f, '--event', ev('deposit', 'a', 't1', 50)]).code, 0);

  // Refund exceeding balance rejected, state unchanged.
  const neg = run(['append', f, '--event', ev('refund', 'a', 't2', 60)]);
  assert.equal(neg.code, 1);
  const refundUnknown = run(['append', f, '--event', ev('refund', 'ghost', 't9', 1)]);
  assert.equal(refundUnknown.code, 1);

  // Duplicate tx rejected.
  assert.equal(run(['append', f, '--event', ev('deposit', 'a', 't1', 1)]).code, 1);

  // Cancel of unknown tx rejected.
  assert.equal(run(['cancel', f, '--tx', 'nope']).code, 1);

  // Valid cancel, then double cancel rejected.
  assert.equal(run(['cancel', f, '--tx', 't1']).code, 0);
  assert.equal(run(['cancel', f, '--tx', 't1']).code, 1);

  const audit = run(['audit', f]);
  assert.equal(audit.code, 0);
  assert.deepEqual(audit.out.state.accounts, { a: 0 });
});
