import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '../cli.js';
import { crc32 } from '../src/crc32.js';
import { Ledger, applyEvent, initialState } from '../src/ledger.js';
import { KIND, HEADER_LEN, decodeIndex } from '../src/format.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
}

// Drives the real CLI entry point in-process (same code path as `node cli.js`).
function runCli(args) {
  const r = run(args);
  return {
    status: r.code,
    stdout: r.stdout.trim() ? JSON.parse(r.stdout) : null,
    stderr: r.stderr.trim() ? JSON.parse(r.stderr) : null,
  };
}

// --- Independent in-test replayer (acceptance oracle) ---------------------
// Deliberately written separately from src/ledger.js applyEvent.
function makeOracle() {
  const txs = new Map();
  let balance = 0;
  let frozen = 0;
  const avail = () => balance - frozen;
  return {
    append(txid, kind, amount) {
      if (txs.has(txid)) return { status: 1, code: 'DUPLICATE_TXID' };
      if (kind === 'debit' && avail() < amount) return { status: 1, code: 'INSUFFICIENT_FUNDS' };
      balance += kind === 'credit' ? amount : -amount;
      txs.set(txid, { kind, amount, status: 'active' });
      return { status: 0 };
    },
    cancel(target) {
      const t = txs.get(target);
      if (!t) return { status: 1, code: 'TX_NOT_FOUND' };
      if (t.status === 'cancelled') return { status: 1, code: 'ALREADY_CANCELLED' };
      if (t.status === 'frozen') return { status: 1, code: 'TX_FROZEN' };
      balance += t.kind === 'credit' ? -t.amount : t.amount;
      t.status = 'cancelled';
      return { status: 0 };
    },
    freeze(target) {
      const t = txs.get(target);
      if (!t) return { status: 1, code: 'TX_NOT_FOUND' };
      if (t.status === 'cancelled') return { status: 1, code: 'ALREADY_CANCELLED' };
      if (t.status === 'frozen') return { status: 1, code: 'ALREADY_FROZEN' };
      if (avail() < t.amount) return { status: 1, code: 'INSUFFICIENT_FUNDS' };
      frozen += t.amount;
      t.status = 'frozen';
      return { status: 0 };
    },
    settle(txid, amount) {
      if (avail() < amount) return { status: 1, code: 'INSUFFICIENT_FUNDS' };
      balance -= amount;
      txs.set(txid, { kind: 'settle', amount, status: 'active' });
      return { status: 0 };
    },
    state() {
      return {
        balance,
        frozen,
        available: avail(),
        txs: Object.fromEntries([...txs.entries()].map(([k, v]) => [k, { ...v }])),
      };
    },
  };
}

function assertStateMatches(dump, expected) {
  assert.equal(dump.balance, expected.balance, 'balance');
  assert.equal(dump.frozen, expected.frozen, 'frozen');
  assert.equal(dump.available, expected.available, 'available');
  assert.deepEqual(dump.txs, expected.txs, 'tx statuses');
}

// --- Unit: CRC32 known vector ---------------------------------------------
test('crc32 matches IEEE known vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

// --- Acceptance 1: small ledger (<=12 events), field-by-field replay -------
test('acceptance 1: small ledger replayed field-by-field against oracle', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'l.dat');
  const oracle = makeOracle();

  const steps = [
    { args: ['append', '--txid', 'A', '--kind', 'credit', '--amount', '1000'], want: () => oracle.append('A', 'credit', 1000) },
    { args: ['append', '--txid', 'B', '--kind', 'credit', '--amount', '500'], want: () => oracle.append('B', 'credit', 500) },
    { args: ['append', '--txid', 'C', '--kind', 'debit', '--amount', '200'], want: () => oracle.append('C', 'debit', 200) },
    { args: ['freeze', '--txid', 'A'], want: () => oracle.freeze('A') },
    { args: ['settle', '--txid', 'S1', '--amount', '100'], want: () => oracle.settle('S1', 100) },
    { args: ['cancel', '--txid', 'C'], want: () => oracle.cancel('C') },
    { args: ['cancel', '--txid', 'A'], want: () => oracle.cancel('A') }, // frozen conflict
    { args: ['cancel', '--txid', 'C'], want: () => oracle.cancel('C') }, // repeat: idempotent no-op, rejected
    { args: ['cancel', '--txid', 'ZZZ'], want: () => oracle.cancel('ZZZ') }, // not found
    { args: ['settle', '--txid', 'S2', '--amount', '99999'], want: () => oracle.settle('S2', 99999) }, // over-settle
    { args: ['append', '--txid', 'D', '--kind', 'debit', '--amount', '50'], want: () => oracle.append('D', 'debit', 50) },
  ];
  assert.ok(steps.length <= 12, 'ledger stays within 12 events');

  for (const [i, step] of steps.entries()) {
    const want = step.want();
    const r = runCli([...step.args, '--file', file]);
    assert.equal(r.status, want.status, `step ${i} (${step.args[0]}) exit code`);
    if (want.status === 0) {
      assert.equal(r.stdout.ok, true);
      assertStateMatches(r.stdout, oracle.state());
    } else {
      assert.equal(r.stderr.ok, false);
      assert.equal(r.stderr.code, want.code, `step ${i} error code`);
      assert.ok('block' in r.stderr && 'message' in r.stderr, 'error has code/block/message');
    }
    // Cross-check via a fresh dump after every step.
    const d = runCli(['dump', '--file', file]);
    assert.equal(d.status, 0);
    assertStateMatches(d.stdout, oracle.state());
  }

  const d = runCli(['dump', '--file', file]);
  assert.equal(d.stdout.blocks, 7); // 11 commands, 4 rejected => 7 blocks
});

// --- Acceptance 2: flip one byte, expect exit 2 and first bad block -------
test('acceptance 2: single-byte flip reports first bad block with exit code 2', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'l.dat');
  for (let i = 0; i < 5; i++) {
    const r = runCli(['append', '--txid', `T${i}`, '--kind', 'credit', '--amount', String(100 * (i + 1)), '--file', file]);
    assert.equal(r.status, 0);
  }

  const idx = decodeIndex(fs.readFileSync(`${file}.idx`));
  assert.equal(idx.length, 5);
  const victim = 2; // 0-based block seq
  const datPath = file;
  const buf = fs.readFileSync(datPath);
  const at = idx[victim].offset + HEADER_LEN + 1; // inside tx payload
  buf[at] ^= 0xff;
  fs.writeFileSync(datPath, buf);

  const v = runCli(['verify', '--file', file]);
  assert.equal(v.status, 2, 'corruption exits 2');
  assert.equal(v.stderr.code, 'CORRUPT_BLOCK');
  assert.equal(v.stderr.block, victim, 'first bad block reported');
  assert.ok(typeof v.stderr.message === 'string');

  // Rebuild keeps only the valid prefix; bad block and everything after
  // must not be merged into state.
  const rb = runCli(['verify', '--rebuild', '--file', file]);
  assert.equal(rb.status, 2);
  assert.equal(rb.stderr.block, victim);

  const d = runCli(['dump', '--file', file]);
  assert.equal(d.status, 0);
  assert.equal(d.stdout.blocks, victim);
  assert.equal(d.stdout.balance, 100 + 200); // only blocks 0 and 1
  assert.deepEqual(Object.keys(d.stdout.txs).sort(), ['T0', 'T1']);

  // Ledger is usable again after rebuild.
  const a = runCli(['append', '--txid', 'T5', '--kind', 'credit', '--amount', '7', '--file', file]);
  assert.equal(a.status, 0);
  assert.equal(a.stdout.balance, 307);
});

// --- Acceptance 3: rebuild after index loss, then idempotent cancel -------
test('acceptance 3: rebuild reproduces index; repeat cancel and over-settle stay rejected', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'l.dat');
  const ok = (args) => {
    const r = runCli([...args, '--file', file]);
    assert.equal(r.status, 0, JSON.stringify(r.stderr));
    return r.stdout;
  };
  ok(['append', '--txid', 'A', '--kind', 'credit', '--amount', '1000']);
  ok(['append', '--txid', 'C', '--kind', 'debit', '--amount', '100']);
  ok(['append', '--txid', 'B', '--kind', 'credit', '--amount', '400']);
  ok(['freeze', '--txid', 'B']);
  ok(['cancel', '--txid', 'C']);
  ok(['settle', '--txid', 'S1', '--amount', '700']);
  // balance 700, frozen 400, available 300

  const idxPath = `${file}.idx`;
  const originalIdx = fs.readFileSync(idxPath);
  const before = runCli(['dump', '--file', file]).stdout;

  // Crash simulation: index lost.
  fs.unlinkSync(idxPath);
  const stuck = runCli(['dump', '--file', file]);
  assert.equal(stuck.status, 1);
  assert.equal(stuck.stderr.code, 'INDEX_MISSING');

  const rb = runCli(['verify', '--rebuild', '--file', file]);
  assert.equal(rb.status, 0, JSON.stringify(rb.stderr));
  assert.equal(rb.stdout.blocks, 6);
  assert.deepEqual(fs.readFileSync(idxPath), originalIdx, 'rebuilt index identical to original');

  const after = runCli(['dump', '--file', file]).stdout;
  assertStateMatches(after, before);

  // Repeated cancel: idempotent (state unchanged), rejected with exit 1.
  const c1 = runCli(['cancel', '--txid', 'C', '--file', file]);
  assert.equal(c1.status, 1);
  assert.equal(c1.stderr.code, 'ALREADY_CANCELLED');
  assertStateMatches(runCli(['dump', '--file', file]).stdout, before);

  // Over-settle: available = balance - frozen = 700 - 400 = 300.
  const s1 = runCli(['settle', '--txid', 'S2', '--amount', '301', '--file', file]);
  assert.equal(s1.status, 1);
  assert.equal(s1.stderr.code, 'INSUFFICIENT_FUNDS');
  assertStateMatches(runCli(['dump', '--file', file]).stdout, before);

  // Boundary: exactly available succeeds.
  const s2 = runCli(['settle', '--txid', 'S2', '--amount', '300', '--file', file]);
  assert.equal(s2.status, 0);
  assert.equal(s2.stdout.available, 0);
});

// --- Unit: incremental decode resumes from index, no full scan ------------
test('incremental decode: state catch-up starts at indexed block, append chains prevCrc', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'l.dat');
  const l1 = Ledger.open(file);
  l1.append({ txid: 'A', kind: 'credit', amount: 500 });
  l1.appendEvents([
    { txid: 'B', kind: KIND.credit, amount: 250, target: null },
    { txid: 'c1', kind: KIND.cancel, amount: 0, target: 'A' },
  ]); // multi-tx block
  l1.settle({ txid: 'S1', amount: 100 });

  // Drop the state snapshot: reopening must rebuild it by decoding blocks
  // located purely through the index (no sequential data-file scan).
  fs.unlinkSync(`${file}.state.json`);
  const l2 = Ledger.open(file);
  assert.deepEqual(l2.dump(), {
    blocks: 3,
    balance: 150, // 500 + 250 - 500(cancel A) - 100(settle)
    frozen: 0,
    available: 150,
    txs: {
      A: { kind: 'credit', amount: 500, status: 'cancelled' },
      B: { kind: 'credit', amount: 250, status: 'active' },
      S1: { kind: 'settle', amount: 100, status: 'active' },
    },
  });

  // Appending after reopen keeps the prevCrc chain intact.
  l2.append({ txid: 'D', kind: 'debit', amount: 50 });
  const l3 = Ledger.open(file);
  const r = l3.verify();
  assert.equal(r.blocks, 4);
  assert.equal(l3.dump().balance, 100);
});

// --- Unit: orphan block (crash after block fsync, before index update) ----
test('orphan block after crash is rejected on write and recovered by rebuild', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'l.dat');
  const l1 = Ledger.open(file);
  l1.append({ txid: 'A', kind: 'credit', amount: 100 });

  // Snapshot generation-1 index/state, then append block B and roll the
  // index/state back: exactly the crash point (block fsynced, index stale).
  const idxGen1 = fs.readFileSync(`${file}.idx`);
  const stateGen1 = fs.readFileSync(`${file}.state.json`);
  l1.append({ txid: 'B', kind: 'credit', amount: 50 });
  fs.writeFileSync(`${file}.idx`, idxGen1);
  fs.writeFileSync(`${file}.state.json`, stateGen1);

  const l2 = Ledger.open(file);
  assert.equal(l2.dump().balance, 100); // orphan not visible yet
  assert.throws(
    () => l2.append({ txid: 'C', kind: 'credit', amount: 1 }),
    (e) => e.code === 'ORPHAN_BLOCKS'
  );

  const r = l2.verify({ rebuild: true });
  assert.equal(r.blocks, 2);
  const l3 = Ledger.open(file);
  assert.equal(l3.dump().balance, 150); // orphan merged after rebuild
  assert.deepEqual(l3.dump().txs.B, { kind: 'credit', amount: 50, status: 'active' });
});
