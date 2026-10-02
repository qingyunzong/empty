import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFrames } from '../src/runner.js';

test('protocol: ack recycles cached responses, retransmit still deduped', () => {
  const frames = [
    { type: 'payment', order: 'o1', amount: 1000, seq: 1, ts: 0 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 100, riskTag: 'low', seq: 2, ts: 10 },
    { type: 'approve', key: 'k1', seq: 3, ts: 20, ack: 2 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 100, riskTag: 'low', seq: 2, ts: 10 },
  ];
  const { report, responses } = runFrames(frames);
  assert.equal(responses.length, 4);
  assert.equal(responses[3].dup, true);
  assert.equal(responses[3].response, null);
  assert.equal(report.keys.k1.state, 'APPROVED');
  assert.equal(report.orders.o1.refunded, 100);
});

test('protocol: seq gap is buffered and flushed in order at EOF', () => {
  const frames = [
    { type: 'payment', order: 'o1', amount: 1000, seq: 1, ts: 0 },
    { type: 'approve', key: 'k1', seq: 4, ts: 30 },
    { type: 'refund', key: 'k1', order: 'o1', amount: 100, riskTag: 'low', seq: 3, ts: 20 },
  ];
  const { report, responses } = runFrames(frames);
  assert.deepEqual(responses.map((r) => r.seq), [1, 3, 4]);
  assert.equal(responses[1].gap, true);
  assert.equal(responses[2].gap, true);
  assert.equal(report.keys.k1.state, 'APPROVED');
});
