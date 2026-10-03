'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ledger = require('../src/ledger');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}

function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: r.status,
    stdout: r.stdout.trim() ? JSON.parse(r.stdout) : null,
    stderr: r.stderr.trim() ? JSON.parse(r.stderr) : null,
  };
}

// Independent in-test reference model used to replay event scripts.
function refState() {
  return { balance: 0, frozen: 0, txs: {} };
}

function refApply(s, ev) {
  switch (ev.type) {
    case 'append':
      if (s.txs[ev.txId]) return 'DUPLICATE_TX';
      s.balance += ev.kind === 'credit' ? ev.amount : -ev.amount;
      s.txs[ev.txId] = { kind: ev.kind, amount: ev.amount, status: 'active' };
      return null;
    case 'settle':
      if (ev.amount > s.balance - s.frozen) return 'INSUFFICIENT_FUNDS';
      s.balance -= ev.amount;
      return null;
    case 'cancel': {
      const tx = s.txs[ev.txId];
      if (!tx) return 'TX_NOT_FOUND';
      if (tx.status === 'cancelled') return 'ALREADY_CANCELLED';
      if (tx.status === 'frozen') return 'FROZEN_CONFLICT';
      s.balance += tx.kind === 'credit' ? -tx.amount : tx.amount;
      tx.status = 'cancelled';
      return null;
    }
    case 'freeze': {
      const tx = s.txs[ev.txId];
      if (!tx) return 'TX_NOT_FOUND';
      if (tx.status === 'frozen') return 'ALREADY_FROZEN';
      if (tx.status === 'cancelled') return 'ALREADY_CANCELLED';
      s.frozen += tx.amount;
      tx.status = 'frozen';
      return null;
    }
    default:
      throw new Error('bad event');
  }
}

function refView(s) {
  return { balance: s.balance, frozen: s.frozen, available: s.balance - s.frozen, txs: s.txs };
}

test('acceptance 1: small ledger replayed against in-test reference, field by field', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'a.ledger');
  const script = [
    { type: 'append', txId: 't1', kind: 'credit', amount: 100 },
    { type: 'append', txId: 't2', kind: 'credit', amount: 50 },
    { type: 'append', txId: 't3', kind: 'debit', amount: 30 },
    { type: 'freeze', txId: 't2' },
    { type: 'settle', amount: 71 },
    { type: 'settle', amount: 70 },
    { type: 'cancel', txId: 't2' },
    { type: 'cancel', txId: 't3' },
    { type: 'cancel', txId: 't3' },
    { type: 'cancel', txId: 'nope' },
    { type: 'append', txId: 't4', kind: 'credit', amount: 20 },
  ];
  assert.ok(script.length <= 12);

  const ref = refState();
  const cancelResults = [];
  const accepted = [];
  for (const ev of script) {
    const expectedCode = refApply(ref, ev);
    const res = ledger.appendEvent(file, ev);
    if (expectedCode === null) {
      assert.equal(res.ok, true, `expected success for ${JSON.stringify(ev)}`);
      accepted.push(ev);
    } else {
      assert.equal(res.ok, false, `expected rejection for ${JSON.stringify(ev)}`);
      assert.equal(res.error.code, expectedCode);
      assert.equal(res.error.block, null);
      assert.equal(typeof res.error.message, 'string');
    }
    if (ev.type === 'cancel') {
      cancelResults.push({ txId: ev.txId, code: expectedCode, got: res.ok ? null : res.error.code });
    }
    // Field-by-field comparison after every event.
    const { state } = ledger.decodeState(file);
    const view = ledger.withAvailable(state);
    const expected = refView(ref);
    assert.equal(view.balance, expected.balance, 'balance mismatch');
    assert.equal(view.frozen, expected.frozen, 'frozen mismatch');
    assert.equal(view.available, expected.available, 'available mismatch');
    assert.deepEqual(view.txs, expected.txs, 'txs mismatch');
  }

  assert.deepEqual(cancelResults, [
    { txId: 't2', code: 'FROZEN_CONFLICT', got: 'FROZEN_CONFLICT' },
    { txId: 't3', code: null, got: null },
    { txId: 't3', code: 'ALREADY_CANCELLED', got: 'ALREADY_CANCELLED' },
    { txId: 'nope', code: 'TX_NOT_FOUND', got: 'TX_NOT_FOUND' },
  ]);

  // Incremental decode starting at an index-recorded block matches reference
  // replay of the accepted tail events (no full-file scan involved).
  const fromSeq = accepted.length - 1; // the final `append t4` block
  const tail = refState();
  for (const ev of accepted.slice(fromSeq)) refApply(tail, ev);
  const partial = ledger.decodeState(file, { fromSeq });
  assert.deepEqual(ledger.withAvailable(partial.state), refView(tail));
});

test('acceptance 2: flipping one byte in a block reports that block with exit code 2', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'b.ledger');
  for (let i = 0; i < 5; i++) {
    ledger.appendEvent(file, { type: 'append', txId: `tx${i}`, kind: 'credit', amount: 10 * (i + 1) });
  }
  const idx = ledger.readIndex(file);
  const target = 2;
  const flipAt = idx.entries[target].offset + 26; // inside payload
  const fd = fs.openSync(file, 'r+');
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, flipAt);
  one[0] ^= 0xff;
  fs.writeSync(fd, one, 0, 1, flipAt);
  fs.closeSync(fd);

  const v = runCli(['verify', file]);
  assert.equal(v.status, 2);
  assert.equal(v.stderr.ok, false);
  assert.equal(v.stderr.error.code, 'CORRUPT_BLOCK');
  assert.equal(v.stderr.error.block, target);
  assert.equal(typeof v.stderr.error.message, 'string');

  const r = runCli(['verify', file, '--rebuild']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr.error.code, 'CORRUPT_BLOCK');
  assert.equal(r.stderr.error.block, target);

  // Blocks after the bad one must not be merged into state.
  const d = runCli(['dump', file]);
  assert.equal(d.status, 0);
  assert.equal(d.stdout.blocks, target);
  assert.deepEqual(
    Object.keys(d.stdout.state.txs).sort(),
    ['tx0', 'tx1'],
  );
  assert.equal(d.stdout.state.balance, 30);
});

test('acceptance 3: rebuild after index deletion, then idempotent cancel and rejected over-settle', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'c.ledger');
  ledger.appendEvent(file, { type: 'append', txId: 't1', kind: 'credit', amount: 100 });
  ledger.appendEvent(file, { type: 'append', txId: 't2', kind: 'credit', amount: 40 });

  const idx = ledger.readIndex(file);
  const originalTail = Buffer.concat([idx.raw, Buffer.from(fs.readFileSync(file).subarray(idx.indexOffset))]);
  const end = ledger.dataEnd(idx.entries);

  // Delete the index (truncate it away), then rebuild.
  fs.truncateSync(file, end);
  const r = runCli(['verify', file, '--rebuild']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.ok, true);
  assert.equal(r.stdout.blocks, 2);

  const rebuilt = ledger.readIndex(file);
  const rebuiltTail = Buffer.concat([rebuilt.raw, Buffer.from(fs.readFileSync(file).subarray(rebuilt.indexOffset))]);
  assert.deepEqual(rebuilt.entries, idx.entries);
  assert.ok(rebuiltTail.equals(originalTail), 'rebuilt index must equal the original index');

  // Repeated cancel: first succeeds, second is rejected and changes nothing.
  const c1 = runCli(['cancel', file, 't2']);
  assert.equal(c1.status, 0);
  const before = runCli(['dump', file]).stdout;
  const c2 = runCli(['cancel', file, 't2']);
  assert.equal(c2.status, 1);
  assert.equal(c2.stderr.error.code, 'ALREADY_CANCELLED');
  assert.deepEqual(runCli(['dump', file]).stdout, before);

  // Over-settlement beyond available is rejected with exit code 1, state unchanged.
  const s = runCli(['settle', file, '999']);
  assert.equal(s.status, 1);
  assert.equal(s.stderr.error.code, 'INSUFFICIENT_FUNDS');
  assert.deepEqual(runCli(['dump', file]).stdout, before);
});

test('crash point: block fsynced but index stale; rebuild recovers the orphan block', () => {
  const dir = tmpdir();
  const crashed = path.join(dir, 'crash.ledger');
  const clean = path.join(dir, 'clean.ledger');
  const events = [
    { type: 'append', txId: 'a', kind: 'credit', amount: 10 },
    { type: 'append', txId: 'b', kind: 'credit', amount: 20 },
    { type: 'settle', amount: 5 },
  ];
  for (const ev of events.slice(0, 2)) {
    ledger.appendEvent(crashed, ev);
    ledger.appendEvent(clean, ev);
  }
  ledger.appendEvent(crashed, events[2], { crashAfterBlockWrite: true });
  ledger.appendEvent(clean, events[2]);

  // Crash state: the orphan block overwrote the old index; no index is readable.
  assert.equal(ledger.readIndex(crashed), null);
  const staleVerify = runCli(['verify', crashed]);
  assert.equal(staleVerify.status, 2);

  const r = runCli(['verify', crashed, '--rebuild']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.blocks, 3);
  assert.deepEqual(ledger.readIndex(crashed).entries, ledger.readIndex(clean).entries);
  assert.deepEqual(runCli(['dump', crashed]).stdout.state, runCli(['dump', clean]).stdout.state);

  // Same crash with a larger index: the orphan block only partially overwrites
  // it, leaving a torn index remnant that rebuild must not mistake for corruption.
  const crashed2 = path.join(dir, 'crash2.ledger');
  const clean2 = path.join(dir, 'clean2.ledger');
  for (let i = 0; i < 12; i++) {
    const ev = { type: 'append', txId: `m${i}`, kind: 'credit', amount: 1 };
    ledger.appendEvent(crashed2, ev);
    ledger.appendEvent(clean2, ev);
  }
  const last = { type: 'settle', amount: 3 };
  ledger.appendEvent(crashed2, last, { crashAfterBlockWrite: true });
  ledger.appendEvent(clean2, last);
  const r2 = runCli(['verify', crashed2, '--rebuild']);
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout.blocks, 13);
  assert.deepEqual(ledger.readIndex(crashed2).entries, ledger.readIndex(clean2).entries);
});

test('freeze does not change balance; normal decode path uses index offsets', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'd.ledger');
  ledger.appendEvent(file, { type: 'append', txId: 'x', kind: 'credit', amount: 80 });
  const before = ledger.decodeState(file).state;
  ledger.appendEvent(file, { type: 'freeze', txId: 'x' });
  const after = ledger.decodeState(file).state;
  assert.equal(after.balance, before.balance);
  assert.equal(after.frozen, 80);
  assert.equal(ledger.withAvailable(after).available, 0);
  const s = runCli(['settle', file, '1']);
  assert.equal(s.status, 1);
  assert.equal(s.stderr.error.code, 'INSUFFICIENT_FUNDS');
});
