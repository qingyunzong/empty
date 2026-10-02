import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFrames } from '../src/runner.js';
import { Engine } from '../src/engine.js';
import { Wal } from '../src/wal.js';

test('1. duplicate refund: business idempotency + protocol retransmission', () => {
  const frames = [
    { type: 'payment', order: 'o1', amount: 1000, seq: 1, ts: 0 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 100, riskTag: 'high', seq: 2, ts: 10 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 100, riskTag: 'high', seq: 3, ts: 20 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 100, riskTag: 'high', seq: 2, ts: 10 },
    { type: 'approve', key: 'k1', seq: 4, ts: 30 },
  ];
  const { report, responses } = runFrames(frames);
  assert.equal(responses.length, 5);
  assert.equal(responses[1].response.status, 'accepted');
  assert.equal(responses[2].response.status, 'duplicate');
  assert.deepEqual(responses[2].response.result, { state: 'PENDING' });
  assert.equal(responses[3].dup, true);
  assert.deepEqual(responses[3].response, responses[1].response);
  assert.equal(report.keys.k1.state, 'APPROVED');
  assert.equal(report.budget.used, 100);
  assert.equal(report.budget.deducted, 100);
  assert.equal(report.orders.o1.refundable, 900);
});

test('1b. same key with different amount is a conflict', () => {
  const frames = [
    { type: 'payment', order: 'o1', amount: 1000, seq: 1, ts: 0 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 100, riskTag: 'low', seq: 2, ts: 10 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 200, riskTag: 'low', seq: 3, ts: 20 },
  ];
  const { report, responses } = runFrames(frames);
  assert.equal(responses[2].response.status, 'error');
  assert.equal(responses[2].response.code, 'CONFLICT');
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].type, 'conflict');
  assert.equal(report.keys.k1.amount, 100);
  assert.equal(report.keys.k1.state, 'PENDING');
});

test('2. out-of-order approve before refund (protocol reorder by seq)', () => {
  const frames = [
    { type: 'payment', order: 'o1', amount: 1000, seq: 1, ts: 0 },
    { type: 'approve', key: 'k1', seq: 3, ts: 20 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 100, riskTag: 'low', seq: 2, ts: 10 },
  ];
  const { report, responses } = runFrames(frames);
  assert.deepEqual(responses.map((r) => r.seq), [1, 2, 3]);
  assert.equal(report.keys.k1.state, 'APPROVED');
});

test('2b. approve with smaller seq than refund (pending decision applied on arrival)', () => {
  const frames = [
    { type: 'payment', order: 'o1', amount: 1000, seq: 1, ts: 0 },
    { type: 'approve', key: 'k1', seq: 2, ts: 5 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 100, riskTag: 'low', seq: 3, ts: 10 },
  ];
  const { report, responses } = runFrames(frames);
  assert.equal(responses[1].response.status, 'pending');
  assert.equal(responses[2].response.decision.state, 'APPROVED');
  assert.equal(report.keys.k1.state, 'APPROVED');
  assert.equal(report.orders.o1.refunded, 100);
});

test('3. budget tie at same timestamp is decided by key', () => {
  const frames = [
    { type: 'payment', order: 'o1', amount: 5000, seq: 1, ts: 0 },
    { type: 'refund', key: 'ka', order: 'o1', amount: 600, riskTag: 'high', seq: 2, ts: 0 },
    { type: 'approve', key: 'ka', seq: 3, ts: 1 },
    { type: 'refund', key: 'kc', order: 'o1', amount: 600, riskTag: 'high', seq: 4, ts: 2 },
    { type: 'refund', key: 'kb', order: 'o1', amount: 600, riskTag: 'high', seq: 5, ts: 2 },
    { type: 'reverse', key: 'ka', seq: 6, ts: 3 },
    { type: 'approve', key: 'kb', seq: 7, ts: 4 },
    { type: 'payment', order: 'o2', amount: 1, seq: 8, ts: 40000 },
  ];
  const { report, responses } = runFrames(frames);
  assert.equal(responses[3].response.state, 'QUEUED');
  assert.equal(responses[4].response.state, 'QUEUED');
  assert.equal(report.keys.ka.state, 'REVERSED');
  assert.equal(report.keys.kb.state, 'APPROVED');
  assert.equal(report.keys.kc.state, 'EXPIRED');
  assert.equal(report.keys.kc.code, 'SLA_EXPIRED');
  assert.equal(report.budget.used, 600);
  assert.equal(report.orders.o1.refunded, 600);
  assert.equal(report.orders.o1.reserved, 0);
});

test('4. expire and late approve', () => {
  const frames = [
    { type: 'payment', order: 'o1', amount: 1000, seq: 1, ts: 0 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 100, riskTag: 'low', seq: 2, ts: 0 },
    { type: 'expire', key: 'k1', seq: 3, ts: 100 },
    { type: 'approve', key: 'k1', seq: 4, ts: 200 },
    { type: 'refund', key: 'k2', order: 'o1', amount: 100, riskTag: 'high', seq: 5, ts: 300 },
    { type: 'payment', order: 'o2', amount: 1, seq: 6, ts: 40000 },
    { type: 'approve', key: 'k2', seq: 7, ts: 40100 },
  ];
  const { report, responses } = runFrames(frames);
  assert.equal(report.keys.k1.state, 'EXPIRED');
  assert.equal(report.keys.k1.code, 'EXPIRED');
  assert.equal(responses[3].response.status, 'late');
  assert.equal(responses[3].response.code, 'ALREADY_EXPIRED');
  assert.equal(report.keys.k2.state, 'EXPIRED');
  assert.equal(report.keys.k2.code, 'SLA_EXPIRED');
  assert.equal(responses[6].response.status, 'late');
  assert.equal(responses[6].response.code, 'ALREADY_EXPIRED');
  assert.equal(report.budget.used, 0);
  assert.equal(report.orders.o1.refundable, 1000);
});

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) out.push([items[i], ...perm]);
  }
  return out;
}

function serialReference(frames) {
  const wal = Wal.open(null);
  const engine = new Engine(wal);
  for (const f of [...frames].sort((a, b) => a.seq - b.seq)) engine.process(f);
  return engine.report();
}

test('5. exhaustive enumeration of <=6 requests matches serial reference', () => {
  const base = [
    { type: 'payment', order: 'o1', amount: 1000, seq: 1, ts: 0 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 200, riskTag: 'high', seq: 2, ts: 10 },
    { type: 'refund', key: 'k2', order: 'o1', amount: 300, riskTag: 'low', seq: 3, ts: 20 },
    { type: 'approve', key: 'k1', seq: 4, ts: 30 },
    { type: 'reject', key: 'k2', seq: 5, ts: 40 },
    { type: 'reverse', key: 'k1', seq: 6, ts: 50 },
  ];
  let checked = 0;
  for (const n of [4, 5, 6]) {
    const subset = base.slice(0, n);
    const expected = serialReference(subset);
    for (const perm of permutations(subset)) {
      const { report } = runFrames(perm);
      assert.deepEqual(report, expected);
      checked += 1;
    }
  }
  assert.equal(checked, 24 + 120 + 720);
});
