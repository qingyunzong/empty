'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFrame, FrameDecoder } = require('../src/frame');
const { Retransmitter } = require('../src/protocol');
const { Engine } = require('../src/engine');
const { scenarioEvents } = require('./helpers');

test('timeout retransmission + dedup yields exactly-once delivery', () => {
  const events = scenarioEvents();
  const frames = events.map((e, i) => ({ key: i, bytes: encodeFrame(e) }));
  const rtx = new Retransmitter({ timeoutMs: 100 });
  const decoder = new FrameDecoder();
  const engine = new Engine();

  const deliver = (bytes) => {
    for (const event of decoder.push(bytes)) engine.apply(event);
  };

  // t=0: all frames sent; frame 0 is lost, frames 1..5 arrive.
  for (const f of frames) rtx.send(f.key, f.bytes, 0);
  for (const f of frames.slice(1)) deliver(f.bytes);
  assert.equal(engine.size, 5);

  // Receiver acks what arrived; frame 0 stays unacked.
  for (const f of frames.slice(1)) rtx.ack(f.key);
  assert.equal(rtx.pending, 1);
  assert.equal(rtx.due(50).length, 0);

  // t=150: timeout fires, frame 0 is retransmitted.
  const again = rtx.due(150);
  assert.equal(again.length, 1);
  deliver(again[0]);
  assert.equal(engine.size, 6);

  // A stray duplicate of frame 1 (ack lost, sender retried) is deduped.
  deliver(frames[1].bytes);
  assert.equal(engine.size, 6);

  engine.finalize();
  assert.equal(engine.contentHash(), engine.recomputeContentHash());
});

test('retransmitter stops resending after ack', () => {
  const rtx = new Retransmitter({ timeoutMs: 10 });
  rtx.send('a', Buffer.from('x'), 0);
  assert.equal(rtx.due(20).length, 1);
  rtx.ack('a');
  assert.equal(rtx.due(40).length, 0);
  assert.equal(rtx.pending, 0);
});
