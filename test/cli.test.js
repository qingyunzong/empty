'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execute } = require('../cli');
const { sign } = require('../src/frames');

const jsonl = (frames) => frames.map((f) => JSON.stringify(sign(f))).join('\n') + '\n';

test('valid input exits 0 and prints a replayable report', () => {
  const res = execute(jsonl([
    { type: 'limits', seq: 0, funds: 100, securities: 10 },
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 5, price: 10, ts: 0 },
    { type: 'new', seq: 2, clOrdId: 'S', side: 'sell', qty: 5, price: 9, ts: 0 },
    { type: 'match', seq: 3, ts: 1 },
    { type: 'settle', seq: 4, ts: 2 },
  ]));
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.fills.length, 1);
  assert.match(out.auditRoot, /^[0-9a-f]{64}$/);
});

test('fragmented frames (pretty-printed / split across lines) are reassembled', () => {
  const frames = [
    sign({ type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 5, price: 10, ts: 0 }),
    sign({ type: 'new', seq: 2, clOrdId: 'S', side: 'sell', qty: 5, price: 9, ts: 0 }),
    sign({ type: 'match', seq: 3, ts: 1 }),
  ];
  // mix pretty-printed multi-line frames with single-line ones
  const text = frames
    .map((f, i) => (i % 2 === 0 ? JSON.stringify(f, null, 2) : JSON.stringify(f)))
    .join('\n');
  const res = execute(text);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).fills.length, 1);
});

test('bad crc exits 2', () => {
  const f = sign({ type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 5, price: 10 });
  f.crc = 'deadbeef';
  const res = execute(JSON.stringify(f) + '\n');
  assert.equal(res.code, 2);
  assert.match(res.stderr, /crc mismatch/);
});

test('malformed JSON exits 2', () => {
  assert.equal(execute('{"type":"new", broken\n').code, 2);
});

test('garbage between frames exits 2', () => {
  assert.equal(execute('{} garbage {}').code, 2);
});

test('conflicting retransmission of the same seq exits 2', () => {
  const res = execute(jsonl([
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 5, price: 10 },
    { type: 'new', seq: 1, clOrdId: 'C', side: 'buy', qty: 5, price: 10 },
  ]));
  assert.equal(res.code, 2);
  assert.match(res.stderr, /conflicting retransmission/);
});

test('unknown origId exits 3', () => {
  const res = execute(jsonl([
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 5, price: 10 },
    { type: 'cancel', seq: 2, origId: 'NOPE' },
  ]));
  assert.equal(res.code, 3);
  assert.match(res.stderr, /unknown origId/);
});

test('duplicate clOrdId with different payload exits 4', () => {
  const res = execute(jsonl([
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 5, price: 10 },
    { type: 'new', seq: 2, clOrdId: 'B', side: 'buy', qty: 6, price: 10 },
  ]));
  assert.equal(res.code, 4);
  assert.match(res.stderr, /duplicate clOrdId/);
});

test('duplicate clOrdId with identical payload is an ignored retransmission', () => {
  const res = execute(jsonl([
    { type: 'new', seq: 1, clOrdId: 'B', side: 'buy', qty: 5, price: 10 },
    { type: 'new', seq: 2, clOrdId: 'B', side: 'buy', qty: 5, price: 10 },
  ]));
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.orders.length, 1);
  assert.equal(out.events.filter((e) => e.kind === 'duplicate_ignored').length, 1);
});
