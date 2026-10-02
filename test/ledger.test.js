'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.join(__dirname, '..', 'cli.js');
const SLOT = 256;

let runSeq = 0;
// The sandbox breaks pipe capture of child stdio, so redirect to files.
function run(args) {
  const tag = `${process.pid}-${runSeq++}`;
  const outFile = path.join(os.tmpdir(), `cli-out-${tag}.txt`);
  const errFile = path.join(os.tmpdir(), `cli-err-${tag}.txt`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  fs.unlinkSync(outFile);
  fs.unlinkSync(errFile);
  return {
    code: r.status,
    stdout,
    stderr,
    json: stdout.trim() ? JSON.parse(stdout) : null,
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}

function append(dir, ev) {
  return run(['append', '--dir', dir, '--slot-size', String(SLOT), '--event', JSON.stringify(ev)]);
}

// Independent reducer used by tests to enumerate expected balances/fees.
function reduceEvents(events) {
  const balances = {};
  const fees = {};
  const txs = {};
  const cancelled = [];
  const bal = (a) => balances[a] || 0;
  for (const ev of events) {
    if (ev.type === 'deposit') {
      balances[ev.account] = bal(ev.account) + ev.amount;
      txs[ev.tx] = ev;
    } else if (ev.type === 'refund') {
      balances[ev.account] = bal(ev.account) - ev.amount;
      txs[ev.tx] = ev;
    } else if (ev.type === 'fee') {
      balances[ev.account] = bal(ev.account) - ev.amount;
      fees[ev.account] = (fees[ev.account] || 0) + ev.amount;
      txs[ev.tx] = ev;
    } else if (ev.type === 'cancel') {
      const orig = txs[ev.refTx];
      if (orig.type === 'deposit') balances[orig.account] -= orig.amount;
      else if (orig.type === 'refund') balances[orig.account] += orig.amount;
      else if (orig.type === 'fee') {
        balances[orig.account] += orig.amount;
        fees[orig.account] -= orig.amount;
      }
      cancelled.push(ev.refTx);
      txs[ev.tx] = ev;
    }
  }
  return { balances, fees, cancelled };
}

const STREAM = [
  { type: 'deposit', account: 'A', tx: 'tx1', amount: 1000 },
  { type: 'deposit', account: 'B', tx: 'tx2', amount: 500 },
  { type: 'fee', account: 'A', tx: 'tx3', amount: 100 },
  { type: 'refund', account: 'A', tx: 'tx4', amount: 300 },
  { type: 'deposit', account: 'A', tx: 'tx5', amount: 200 },
  { type: 'deposit', account: 'B', tx: 'tx6', amount: 400 },
  { type: 'fee', account: 'B', tx: 'tx7', amount: 50 },
  { type: 'refund', account: 'B', tx: 'tx8', amount: 150 },
  { type: 'deposit', account: 'C', tx: 'tx9', amount: 250 },
  { type: 'fee', account: 'C', tx: 'tx10', amount: 20 },
];

test('small stream: audit matches independent enumeration and find path', () => {
  const dir = tmpdir();
  const written = [];
  for (const ev of STREAM) {
    const r = append(dir, ev);
    assert.equal(r.code, 0, r.stderr);
    written.push(ev);
  }
  // cancel tx2 (B's first deposit) via the CLI so it links to the original
  const c = run(['cancel', '--dir', dir, '--tx', 'tx2']);
  assert.equal(c.code, 0, c.stderr);
  assert.equal(c.json.event.refTx, 'tx2');
  written.push(c.json.event);

  const expected = reduceEvents(written);

  // audit path
  const audit = run(['audit', '--dir', dir]);
  assert.equal(audit.code, 0, audit.stderr);
  assert.equal(audit.json.status, 'ok');
  assert.deepEqual(audit.json.balances, expected.balances);
  assert.deepEqual(audit.json.fees, expected.fees);
  assert.ok(audit.json.chunks.length >= 3, 'stream should span multiple chunks');

  // query path: every tx locatable via the index
  for (const ev of written) {
    const f = run(['find', '--dir', dir, '--tx', ev.tx]);
    assert.equal(f.code, 0, f.stderr);
    assert.ok(f.json.events.some((e) => e.tx === ev.tx), `tx ${ev.tx} found`);
  }
  // cancel is linked to the original event
  const linked = run(['find', '--dir', dir, '--tx', 'tx2']);
  assert.ok(linked.json.events.some((e) => e.type === 'cancel' && e.refTx === 'tx2'));

  // per-account enumeration through find matches audit balances
  for (const acct of ['A', 'B', 'C']) {
    const f = run(['find', '--dir', dir, '--account', acct]);
    assert.equal(f.code, 0, f.stderr);
    const got = reduceEvents(f.json.events);
    assert.equal(got.balances[acct] || 0, expected.balances[acct] || 0, `balance ${acct}`);
    assert.equal(got.fees[acct] || 0, expected.fees[acct] || 0, `fees ${acct}`);
  }

  // business errors exit 1
  const neg = append(dir, { type: 'refund', account: 'A', tx: 'tx-bad', amount: 999999 });
  assert.equal(neg.code, 1);
  const unknownCancel = run(['cancel', '--dir', dir, '--tx', 'nope']);
  assert.equal(unknownCancel.code, 1);
  const dup = append(dir, { type: 'deposit', account: 'A', tx: 'tx1', amount: 1 });
  assert.equal(dup.code, 1);
  // failed appends did not change state
  const audit2 = run(['audit', '--dir', dir]);
  assert.deepEqual(audit2.json.balances, expected.balances);
});

test('middle chunk corruption: quarantine point, pending chunks, frozen state', () => {
  const dir = tmpdir();
  const written = [];
  for (const ev of STREAM) {
    assert.equal(append(dir, ev).code, 0);
    written.push(ev);
  }
  const before = run(['audit', '--dir', dir]);
  assert.equal(before.code, 0);
  const chunks = before.json.chunks;
  assert.ok(chunks.length >= 3, `need >=3 chunks, got ${chunks.length}`);

  // expected state = events of chunks before the corrupted one (chunk index 1)
  const inChunk0 = written.slice(0, chunks[0].eventCount);
  const expected = reduceEvents(inChunk0);

  // flip a byte inside chunk 1's payload
  const ledger = path.join(dir, 'ledger.dat');
  const buf = fs.readFileSync(ledger);
  const off = 2 * SLOT + 70; // slot 2 = chunk index 1, past the 60-byte header
  buf[off] = buf[off] ^ 0xff;
  fs.writeFileSync(ledger, buf);

  const q = run(['quarantine', '--dir', dir]);
  assert.equal(q.code, 2);
  assert.deepEqual(q.json.quarantined, [1]);
  assert.deepEqual(q.json.pending, chunks.slice(2).map((c) => c.index));

  const after = run(['audit', '--dir', dir]);
  assert.equal(after.code, 2);
  assert.equal(after.json.status, 'corrupted');
  assert.deepEqual(after.json.quarantined, [1]);
  assert.deepEqual(after.json.pending, chunks.slice(2).map((c) => c.index));
  // state contains only chunks confirmed before the quarantine point
  assert.deepEqual(after.json.balances, expected.balances);
  assert.deepEqual(after.json.fees, expected.fees);

  // find on a tx in a confirmed chunk still works without scanning bad chunks
  const okTx = inChunk0[0].tx;
  const f = run(['find', '--dir', dir, '--tx', okTx]);
  assert.equal(f.code, 0, f.stderr);
  assert.ok(f.json.events.some((e) => e.tx === okTx));

  // find on a tx inside the quarantined chunk reports corruption (exit 2)
  const badTx = written[chunks[0].eventCount].tx;
  const fb = run(['find', '--dir', dir, '--tx', badTx]);
  assert.equal(fb.code, 2);

  // appends are refused while the chain is broken
  const a = append(dir, { type: 'deposit', account: 'A', tx: 'tx-late', amount: 1 });
  assert.equal(a.code, 2);
});

test('zero padding tail: rebuild truncates, recovery survives restart, idempotent', () => {
  const dir = tmpdir();
  const written = [];
  for (const ev of STREAM) {
    assert.equal(append(dir, ev).code, 0);
    written.push(ev);
  }
  const expected = reduceEvents(written);
  const ledger = path.join(dir, 'ledger.dat');
  const sizeBefore = fs.statSync(ledger).size;
  assert.equal(sizeBefore % SLOT, 0);

  // simulate an unfinished tail: 2 full zero slots + a partial zero slot
  fs.appendFileSync(ledger, Buffer.alloc(2 * SLOT + 100));

  const r1 = run(['rebuild', '--dir', dir]);
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(r1.json.truncated, 3); // 2 zero slots + 1 partial
  assert.equal(fs.statSync(ledger).size, sizeBefore);

  // idempotent: second rebuild truncates nothing
  const r2 = run(['rebuild', '--dir', dir]);
  assert.equal(r2.code, 0);
  assert.equal(r2.json.truncated, 0);

  // state intact after recovery
  const audit = run(['audit', '--dir', dir]);
  assert.equal(audit.code, 0);
  assert.deepEqual(audit.json.balances, expected.balances);
  assert.deepEqual(audit.json.fees, expected.fees);

  // appending after restart also self-heals a fresh zero tail
  fs.appendFileSync(ledger, Buffer.alloc(SLOT));
  const a = append(dir, { type: 'deposit', account: 'A', tx: 'tx11', amount: 5 });
  assert.equal(a.code, 0, a.stderr);
  const audit2 = run(['audit', '--dir', dir]);
  assert.equal(audit2.code, 0);
  assert.equal(audit2.json.balances.A, expected.balances.A + 5);
});
