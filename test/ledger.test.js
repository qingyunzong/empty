import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.js';
import { runCli as runCliEntry } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ledger-'));
}

function cli(args) {
  let stdout = '';
  let stderr = '';
  const status = runCliEntry(args, {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { status, stdout, stderr };
}

function parseOk(res) {
  assert.equal(res.status, 0, `expected exit 0, stderr: ${res.stderr}`);
  const body = JSON.parse(res.stdout);
  assert.equal(body.ok, true);
  return body;
}

function parseErr(res, code) {
  assert.notEqual(res.status, 0, `expected failure for code ${code}, stdout: ${res.stdout}`);
  const body = JSON.parse(res.stderr);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, code);
  assert.ok(Array.isArray(body.error.range), `error ${code} must carry a range`);
  return body.error;
}

// Independent reference reducer used to cross-check decoded state.
function refApply(state, event) {
  if (event.type === 'payment') {
    (state.accounts[event.account] ??= { balance: 0, credit: 0 }).balance += event.amount;
    state.payments[event.id] = { account: event.account, amount: event.amount, cancelled: false };
  } else if (event.type === 'cancel') {
    const payment = state.payments[event.paymentId];
    payment.cancelled = true;
    state.accounts[payment.account].balance -= payment.amount;
  } else if (event.type === 'adjust') {
    (state.accounts[event.account] ??= { balance: 0, credit: 0 }).credit += event.delta;
  } else {
    throw new Error(`bad event ${event.type}`);
  }
}

test('tail decode matches full enumeration for various N', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'ledger.bin');
  const ledger = new Ledger(file);
  const batches = [
    [{ type: 'adjust', account: 'alice', delta: 1000 }],
    [
      { type: 'payment', id: 'p1', account: 'alice', amount: 100 },
      { type: 'payment', id: 'p2', account: 'alice', amount: 250 },
    ],
    [{ type: 'adjust', account: 'bob', delta: 500 }],
    [{ type: 'payment', id: 'p3', account: 'bob', amount: 500 }],
    [{ type: 'cancel', paymentId: 'p2' }],
    [
      { type: 'payment', id: 'p4', account: 'alice', amount: 50 },
      { type: 'adjust', account: 'alice', delta: -800 },
    ],
    [{ type: 'payment', id: 'p5', account: 'alice', amount: 40 }],
    [{ type: 'cancel', paymentId: 'p4' }],
  ];
  const allEvents = [];
  const refStates = [{ accounts: {}, payments: {} }];
  for (const batch of batches) {
    ledger.appendEvents(batch);
    for (const event of batch) {
      allEvents.push(event);
      const state = structuredClone(refStates[refStates.length - 1]);
      refApply(state, event);
      refStates.push(state);
    }
    if (allEvents.length === 5) ledger.snapshot();
  }
  const total = allEvents.length;
  assert.equal(total, 10);

  // The snapshot at seq 5 is the latest anchor: windows never cross it,
  // so the effective count is clamped to the events since the anchor.
  const anchorSeq = 5;
  const available = total - anchorSeq;
  for (const n of [1, 2, 3, 5, 8, total, total + 50]) {
    const tail = ledger.tail(n);
    const count = Math.min(n, available);
    const expected = allEvents
      .slice(total - count)
      .map((event, i) => ({ seq: total - count + i + 1, event }));
    assert.deepEqual(tail.events, expected, `events for n=${n}`);
    assert.deepEqual(tail.finalState, refStates[total], `finalState for n=${n}`);
    assert.deepEqual(tail.stateAtWindowStart, refStates[total - count], `window-start state for n=${n}`);
    assert.equal(tail.window.eventCount, count);
    assert.equal(tail.window.toSeq, total);
  }

  // Window stops at the latest anchor and never reads earlier snapshots.
  const tailAll = ledger.tail(total + 50);
  assert.equal(tailAll.anchor.seq, 5);
  assert.equal(tailAll.blocksRead, 5); // snapshot anchor + 4 delta blocks, not the genesis prefix

  const cliTail = parseOk(cli(['tail', file, '--n', '3']));
  assert.deepEqual(cliTail.events, ledger.tail(3).events);
  assert.deepEqual(cliTail.finalState, refStates[total]);

  const summary = parseOk(cli(['verify', file]));
  assert.equal(summary.events, total);
  assert.equal(summary.anchors, 2);
  assert.equal(summary.lastSeq, total);
});

test('business rule violations produce JSON errors with code and range', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'ledger.bin');
  parseOk(
    cli([
      'append',
      file,
      JSON.stringify([
        { type: 'adjust', account: 'alice', delta: 100 },
        { type: 'payment', id: 'p1', account: 'alice', amount: 50 },
      ]),
    ]),
  );

  // cancel of an unknown payment is rejected
  let err = parseErr(cli(['cancel', file, 'nope']), 'UNKNOWN_PAYMENT');
  assert.deepEqual(err.range, [3, 3]);

  // first cancel succeeds, second cancel of the same payment is rejected
  parseOk(cli(['cancel', file, 'p1']));
  err = parseErr(cli(['cancel', file, 'p1']), 'ALREADY_CANCELLED');
  assert.deepEqual(err.range, [4, 4]);

  // credit adjustment that would drive available (credit - balance) negative
  err = parseErr(
    cli(['append', file, JSON.stringify({ type: 'adjust', account: 'alice', delta: -200 })]),
    'NEGATIVE_AVAILABLE',
  );
  assert.deepEqual(err.range, [4, 4]);

  // failed appends left the chain untouched
  const summary = parseOk(cli(['verify', file]));
  assert.equal(summary.lastSeq, 3);
  assert.equal(summary.events, 3);
});

test('manifest crash recovery, then CRC corruption keeps anchor prefix readable', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'ledger.bin');
  const ledger = new Ledger(file);
  ledger.appendEvents([{ type: 'adjust', account: 'alice', delta: 1000 }]); // seq 1
  ledger.snapshot(); // anchor at seq 1
  ledger.appendEvents([{ type: 'payment', id: 'p1', account: 'alice', amount: 100 }]); // seq 2
  const oldManifest = fs.readFileSync(`${file}.manifest`);
  const stateAfterSeq2 = ledger.tail(100).finalState;

  const blockBOffset = fs.statSync(file).size;
  ledger.appendEvents([{ type: 'payment', id: 'p2', account: 'alice', amount: 30 }]); // seq 3
  const newManifest = fs.readFileSync(`${file}.manifest`);

  // Simulate a crash before the manifest rename: old manifest in place, stray temp left behind.
  fs.writeFileSync(`${file}.manifest`, oldManifest);
  fs.writeFileSync(`${file}.manifest.new`, Buffer.from('partial garbage'));
  const crashed = parseOk(cli(['tail', file, '--n', '100']));
  assert.deepEqual(crashed.finalState, stateAfterSeq2);
  assert.equal(crashed.window.toSeq, 2);
  assert.ok(!fs.existsSync(`${file}.manifest.new`), 'stale temp manifest must be cleaned up');

  // Restore the current manifest, then corrupt the payload of the newest delta block.
  fs.writeFileSync(`${file}.manifest`, newManifest);
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, Buffer.from([0xff]), 0, 1, blockBOffset + 68 + 2);
  } finally {
    fs.closeSync(fd);
  }

  // Tail decode fails on the corrupted block with a JSON error carrying code and range.
  const err = parseErr(cli(['tail', file, '--n', '5']), 'CRC_MISMATCH');
  assert.deepEqual(err.range, [3, 3]);

  // The anchor prefix is still readable.
  const anchor = parseOk(cli(['anchor', file]));
  assert.equal(anchor.anchor.seq, 1);
  assert.deepEqual(anchor.corrupt, [{ offset: blockBOffset, range: [3, 3] }]);

  // Verify reports the readable prefix before the corrupted block.
  const verr = parseErr(cli(['verify', file]), 'CRC_MISMATCH');
  assert.deepEqual(verr.range, [3, 3]);
  assert.equal(verr.details.validThroughSeq, 2);
});
