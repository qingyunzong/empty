'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/simulator');
const { ScriptedChannel } = require('../src/channel');
const Scheduler = require('../src/scheduler');
const Terminal = require('../src/terminal');
const { ProtocolError } = require('../src/errors');

// Acceptance 1: a lost ACK triggers retransmission; budget is charged once.
test('lost ACK retransmits without double-charging budget', () => {
  // Transmission 0: cmd delivered. Transmission 1: ACK dropped.
  // Transmission 2: retransmitted cmd delivered (terminal dedups).
  // Transmission 3: ACK delivered.
  const channel = new ScriptedChannel(new Set([1]));
  const report = run([{ op: 'PLAN', id: 'A', ver: 1, cost: 30 }], {
    cap: 100,
    channel,
  });

  assert.equal(report.ok, true);
  assert.equal(report.used, 30, 'budget charged exactly once');
  assert.equal(report.ledger.length, 1, 'single ledger flow');
  assert.deepEqual(
    report.ledger.map((e) => [e.op, e.id, e.delta, e.used]),
    [['PLAN', 'A', 30, 30]]
  );
  assert.equal(report.stats.retransmissions, 1);
  assert.equal(report.stats.terminal.duplicates, 1, 'terminal deduped the retry');
  assert.equal(report.pending.length, 0);
});

test('exponential backoff doubles the timeout each retry', () => {
  // Drop the first three command transmissions, then deliver cmd + ACK.
  const channel = new ScriptedChannel(new Set([0, 1, 2]));
  const report = run([{ op: 'PLAN', id: 'A', ver: 1, cost: 10 }], {
    cap: 100,
    channel,
    baseTimeout: 4,
  });
  assert.equal(report.ok, true);
  assert.equal(report.stats.retransmissions, 3);
  assert.equal(report.stats.time, 4 + 8 + 16, 'backoff waits 4, 8, 16 ticks');
});

test('max retries exceeded is a protocol error', () => {
  const channel = new ScriptedChannel(() => true); // drop everything
  assert.throws(
    () => run([{ op: 'PLAN', id: 'A', ver: 1, cost: 10 }], { cap: 100, channel, maxRetries: 3 }),
    (err) => {
      assert.equal(err instanceof ProtocolError, true);
      assert.match(err.message, /no reply after 3 attempts/);
      assert.equal(err.report.used, 0, 'state untouched');
      return true;
    }
  );
});

test('scheduler dedups duplicate ACKs', () => {
  const s = new Scheduler();
  s.dispatch({ op: 'PLAN', id: 'A', ver: 1, cost: 10 });
  const first = s.onReply({ status: 'ACK', id: 'A', ver: 1 });
  assert.equal(first.confirmed, true);
  const dup = s.onReply({ status: 'ACK', id: 'A', ver: 1 });
  assert.equal(dup.ignored, true);
  assert.equal(s.stats.duplicateAcks, 1);
});

test('scheduler rejects mismatched or unsolicited replies', () => {
  const s = new Scheduler();
  assert.throws(() => s.onReply({ status: 'ACK', id: 'A', ver: 1 }), ProtocolError);
  s.dispatch({ op: 'PLAN', id: 'A', ver: 1, cost: 10 });
  assert.throws(() => s.onReply({ status: 'ACK', id: 'B', ver: 1 }), ProtocolError);
});

test('terminal ignores out-of-order lower ver', () => {
  const t = new Terminal(100);
  const ack = t.receive({ op: 'PLAN', id: 'A', ver: 2, cost: 10 });
  assert.equal(ack.status, 'ACK');
  const stale = t.receive({ op: 'CANCEL', id: 'A', ver: 1 });
  assert.equal(stale, null, 'stale ver ignored');
  assert.equal(t.stats.staleIgnored, 1);
  assert.equal(t.ledger.used, 10, 'state unchanged by stale command');
});

test('terminal dedups exact retransmit but rejects conflicting payload', () => {
  const t = new Terminal(100);
  t.receive({ op: 'PLAN', id: 'A', ver: 1, cost: 10 });
  const dup = t.receive({ op: 'PLAN', id: 'A', ver: 1, cost: 10 });
  assert.equal(dup.status, 'ACK');
  assert.equal(t.ledger.used, 10, 'not applied twice');
  assert.throws(
    () => t.receive({ op: 'PLAN', id: 'A', ver: 1, cost: 99 }),
    ProtocolError
  );
});

test('seeded lossy channel: all commands confirmed, budget correct', () => {
  const ops = [
    { op: 'PLAN', id: 'A', ver: 1, cost: 20, start: 1 },
    { op: 'PLAN', id: 'B', ver: 1, cost: 30, start: 2 },
    { op: 'MOVE', id: 'A', ver: 2, cost: 10, start: 3 },
    { op: 'CANCEL', id: 'B', ver: 2 },
  ];
  const report = run(ops, { cap: 100, seed: 7, loss: 0.4 });
  assert.equal(report.ok, true);
  assert.equal(report.used, 10);
  assert.equal(report.stats.retransmissions > 0, true, 'loss caused retries');
  assert.deepEqual(report.plan, [{ id: 'A', start: 3, end: null, cost: 10, ver: 2 }]);
});
