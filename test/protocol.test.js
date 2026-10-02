'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Protocol, FrameError, parseFrame } = require('../src/protocol');

const op = (key) => ({ op: 'refund', key, order: 'o1', amount: 10, riskTag: 'low', paid: 100 });

test('parseFrame rejects malformed frames', () => {
  assert.throws(() => parseFrame('not json'), FrameError);
  assert.throws(() => parseFrame('[1,2]'), FrameError);
  assert.throws(() => parseFrame('{"op":{}}'), FrameError);
  assert.throws(() => parseFrame('{"seq":-1,"op":{"op":"refund"}}'), FrameError);
  assert.throws(() => parseFrame('{"seq":0,"op":{"op":1}}'), FrameError);
  const ok = parseFrame('{"seq":0,"ack":0,"t":5,"op":{"op":"refund"}}');
  assert.equal(ok.seq, 0);
});

test('in-order frames are applied exactly once, in order', () => {
  const p = new Protocol();
  const applied = [];
  const apply = (o, t, seq) => { applied.push([seq, o.key]); return { seq }; };
  let out = p.ingest(parseFrame(JSON.stringify({ seq: 0, t: 0, op: op('a') })), apply);
  assert.deepEqual(out.map((e) => e.ack), [0]);
  out = p.ingest(parseFrame(JSON.stringify({ seq: 1, t: 1, op: op('b') })), apply);
  assert.deepEqual(out.map((e) => e.ack), [1]);
  assert.deepEqual(applied, [[0, 'a'], [1, 'b']]);
});

test('retransmission returns the stored result without re-executing', () => {
  const p = new Protocol();
  let calls = 0;
  const apply = () => { calls++; return { n: calls }; };
  const frame = JSON.stringify({ seq: 0, t: 0, op: op('a') });
  const first = p.ingest(parseFrame(frame), apply);
  const again = p.ingest(parseFrame(frame), apply);
  assert.equal(calls, 1, 'no double execution');
  assert.deepEqual(again[0].result, first[0].result);
  assert.equal(again[0].dup, true);
});

test('out-of-order frames are buffered and flushed in seq order', () => {
  const p = new Protocol();
  const applied = [];
  const apply = (o, t, seq) => { applied.push(seq); return { seq }; };
  // approve (seq 1) arrives before refund (seq 0)
  let out = p.ingest(parseFrame(JSON.stringify({ seq: 1, t: 5, op: { op: 'approve', key: 'a' } })), apply);
  assert.equal(out.length, 0, 'held until the gap fills');
  out = p.ingest(parseFrame(JSON.stringify({ seq: 0, t: 0, op: op('a') })), apply);
  assert.deepEqual(out.map((e) => e.ack), [0, 1], 'both delivered once seq 0 lands');
  assert.deepEqual(applied, [0, 1], 'business core sees them in order');
  // duplicate of the buffered frame is harmless
  out = p.ingest(parseFrame(JSON.stringify({ seq: 1, t: 5, op: { op: 'approve', key: 'a' } })), apply);
  assert.equal(out.length, 1);
  assert.equal(out[0].dup, true);
  assert.deepEqual(applied, [0, 1]);
});

test('gaps: frames beyond a missing seq wait; old frames replay results', () => {
  const p = new Protocol();
  const apply = (o, t, seq) => ({ seq });
  p.ingest(parseFrame(JSON.stringify({ seq: 0, t: 0, op: op('a') })), apply);
  let out = p.ingest(parseFrame(JSON.stringify({ seq: 2, t: 2, op: op('c') })), apply);
  assert.equal(out.length, 0, 'seq 2 waits for missing seq 1');
  out = p.ingest(parseFrame(JSON.stringify({ seq: 0, t: 0, op: op('a') })), apply);
  assert.equal(out[0].dup, true);
  out = p.ingest(parseFrame(JSON.stringify({ seq: 1, t: 1, op: op('b') })), apply);
  assert.deepEqual(out.map((e) => e.ack), [1, 2]);
});
