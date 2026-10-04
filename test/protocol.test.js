'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFrame, decodeFrame, fragmentMessage, Receiver } = require('../src/protocol');
const { FrameError } = require('../src/errors');

test('fragmentation and reassembly of a multi-frame message', () => {
  const message = JSON.stringify({ data: 'x'.repeat(500) });
  const frames = fragmentMessage(42, message, 64);
  assert.ok(frames.length > 1);
  const receiver = new Receiver();
  let out = [];
  for (const f of frames) out = out.concat(receiver.feed(f));
  assert.equal(out.length, 1);
  assert.equal(out[0], message);
});

test('out-of-order fragments reassemble correctly', () => {
  const message = 'hello-fragmented-world-'.repeat(10);
  const frames = fragmentMessage(7, message, 16);
  const receiver = new Receiver();
  const order = [2, 0, frames.length - 1, 1];
  const seen = new Set(order);
  for (let i = 0; i < frames.length; i++) if (!seen.has(i)) order.push(i);
  let out = [];
  for (const i of order) out = out.concat(receiver.feed(frames[i]));
  assert.deepEqual(out, [message]);
});

test('duplicate frames and retransmitted messages are idempotent', () => {
  const frames = fragmentMessage(9, 'payload', 4);
  const receiver = new Receiver();
  let out = [];
  for (const f of frames) out = out.concat(receiver.feed(f));
  assert.equal(out.length, 1);
  // retransmission of every frame after completion: no re-delivery
  for (const f of frames) assert.deepEqual(receiver.feed(f), []);
  assert.equal(out.length, 1);
});

test('timeout expires partial groups; retransmission rebuilds them', () => {
  const frames = fragmentMessage(11, 'retransmit-me-please', 8);
  assert.ok(frames.length >= 2);
  const receiver = new Receiver({ timeoutMs: 100 });
  assert.deepEqual(receiver.feed(frames[0], 1000), []); // partial at t=1000
  receiver.purgeExpired(1201); // timed out
  // sender retransmits the full sequence after the timeout
  let out = [];
  frames.forEach((f, i) => { out = out.concat(receiver.feed(f, 1202 + i)); });
  assert.deepEqual(out, ['retransmit-me-please']);
});

test('malformed frames raise FrameError (exit 2)', () => {
  const good = encodeFrame({ msgId: 1, payload: Buffer.from('a') });
  const badMagic = Buffer.from(good); badMagic[0] = 0x00;
  assert.throws(() => decodeFrame(badMagic), (e) => e instanceof FrameError && e.exitCode === 2);
  assert.throws(() => decodeFrame(good.subarray(0, 5)), FrameError); // truncated
  const badLen = Buffer.concat([good, Buffer.from('x')]);
  assert.throws(() => decodeFrame(badLen), FrameError); // length mismatch
  assert.throws(() => encodeFrame({ msgId: 1, fragIndex: 1, fragCount: 1, payload: Buffer.from('a') }), FrameError);
  const badVersion = Buffer.from(good); badVersion[2] = 99;
  assert.throws(() => decodeFrame(badVersion), FrameError);
});
