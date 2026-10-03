'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Gateway, ConflictError } = require('../lib/gateway');
const { VirtualClock } = require('../lib/clock');
const { encode, TYPE, StructuralError } = require('../lib/frame');
const { merkleRoot } = require('../lib/merkle');

function payloadOf(n, seed = 7) {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = (i * 31 + seed) & 0xFF;
  return buf;
}

function splitEvery(payload, size) {
  const chunks = [];
  for (let off = 0; off < payload.length; off += size) {
    chunks.push({ offset: off, payload: payload.subarray(off, Math.min(off + size, payload.length)) });
  }
  return chunks;
}

function makeGateway() {
  const clock = new VirtualClock();
  const events = [];
  const gw = new Gateway({ clock, missingTimeoutMs: 1000, onEvent: (e) => events.push(e) });
  return { gw, clock, events };
}

function data(board, session, chunk, opts) {
  return encode({ type: TYPE.DATA, board, session, offset: chunk.offset, payload: chunk.payload, ...opts });
}

test('acceptance 1: out-of-order retransmitted fragments match one-shot reference root', () => {
  const payload = payloadOf(5000);
  const chunks = splitEvery(payload, 640);
  const shuffled = [...chunks].reverse(); // deterministic out-of-order
  const { gw, events } = makeGateway();
  for (const c of shuffled) gw.feed(data(7, 1, c));
  gw.feed(data(7, 1, shuffled[0])); // retransmit, deduped by offset
  gw.feed(data(7, 1, shuffled[2]));
  gw.feed(encode({ type: TYPE.END, board: 7, session: 1 }));
  gw.end();

  // One-shot reference: a single DATA frame carrying the whole payload.
  gw.feed(encode({ type: TYPE.DATA, board: 8, session: 1, offset: 0, payload }));
  gw.feed(encode({ type: TYPE.END, board: 8, session: 1 }));
  gw.end();

  const certs = gw.certs();
  const fragmented = certs.find((c) => c.board === 7);
  const oneShot = certs.find((c) => c.board === 8);
  assert.equal(fragmented.status, 'committed');
  assert.equal(fragmented.merkleRoot, oneShot.merkleRoot);
  assert.equal(fragmented.merkleRoot, merkleRoot(payload));
  assert.equal(fragmented.receivedBytes, payload.length);
  assert.equal(fragmented.retransmits, 2);
  assert.equal(events.filter((e) => e.event === 'retransmit').length, 2);
});

test('acceptance 2: truncated tail after restart does not pollute committed certs', () => {
  const payload = payloadOf(100);
  const { gw, events } = makeGateway();
  gw.feed(data(1, 1, { offset: 0, payload }));
  gw.feed(encode({ type: TYPE.END, board: 1, session: 1 }));
  // Crash mid-frame: only part of the next frame arrives before "restart".
  const half = data(2, 1, { offset: 0, payload: payloadOf(50) }).subarray(0, 9);
  gw.feed(half);
  assert.throws(() => gw.end(), (e) => e instanceof StructuralError && e.code === 'truncated_tail');
  const certs = gw.certs();
  assert.equal(certs.length, 1);
  assert.equal(certs[0].board, 1);
  assert.equal(certs[0].status, 'committed');
  assert.equal(certs[0].merkleRoot, merkleRoot(payload));
  assert.ok(events.some((e) => e.event === 'truncated_tail'));
});

test('acceptance 3: same-session conflict is rejected and old cert preserved', () => {
  const payload = payloadOf(64);
  const { gw, events } = makeGateway();
  gw.feed(data(1, 1, { offset: 0, payload }));
  gw.feed(encode({ type: TYPE.END, board: 1, session: 1 }));
  const before = gw.certs();
  assert.throws(
    () => gw.feed(data(1, 1, { offset: 0, payload: payloadOf(8, 99) })),
    (e) => e instanceof ConflictError,
  );
  assert.deepEqual(gw.certs(), before); // old cert untouched
  assert.ok(events.some((e) => e.event === 'conflict'));
  // ABORT after END is ignored, cert still intact.
  gw.feed(encode({ type: TYPE.ABORT, board: 1, session: 5, payload: Buffer.from('late') }));
  assert.deepEqual(gw.certs(), before);
  assert.ok(events.some((e) => e.event === 'ignored' && e.reason === 'abort_after_end'));
});

test('aborted board requires incremented session for a new run', () => {
  const { gw } = makeGateway();
  gw.feed(data(3, 1, { offset: 0, payload: payloadOf(10) }));
  gw.feed(encode({ type: TYPE.ABORT, board: 3, session: 1, payload: Buffer.from('nozzle_jam') }));
  let cert = gw.certs().find((c) => c.board === 3);
  assert.equal(cert.status, 'aborted');
  assert.equal(cert.discardReason, 'nozzle_jam');
  assert.equal(cert.receivedBytes, 10);

  // Same session after ABORT -> conflict.
  assert.throws(() => gw.feed(data(3, 1, { offset: 0, payload: payloadOf(4) })), ConflictError);
  // Incremented session -> accepted and commits, replacing the aborted cert.
  const payload = payloadOf(32);
  gw.feed(data(3, 2, { offset: 0, payload }));
  gw.feed(encode({ type: TYPE.END, board: 3, session: 2 }));
  cert = gw.certs().find((c) => c.board === 3);
  assert.equal(cert.status, 'committed');
  assert.equal(cert.session, 2);
  assert.equal(cert.merkleRoot, merkleRoot(payload));
});

test('bad crc is logged and never terminates the stream', () => {
  const payload = payloadOf(100);
  const { gw, events } = makeGateway();
  gw.feed(data(1, 1, { offset: 0, payload: payload.subarray(0, 50) }));
  gw.feed(data(1, 1, { offset: 50, payload: payload.subarray(50) }, { corruptCrc: true }));
  gw.feed(data(1, 1, { offset: 50, payload: payload.subarray(50) })); // good retransmit heals it
  gw.feed(encode({ type: TYPE.END, board: 1, session: 1 }));
  gw.end();
  assert.equal(gw.stats.badCrc, 1);
  assert.ok(events.some((e) => e.event === 'bad_crc'));
  assert.equal(gw.certs()[0].merkleRoot, merkleRoot(payload));
});

test('missing fragments trigger retransmit requests on the virtual clock', () => {
  const { gw, clock, events } = makeGateway();
  gw.feed(data(1, 1, { offset: 100, payload: payloadOf(50) })); // gap [0,100)
  clock.advance(999);
  assert.equal(events.filter((e) => e.event === 'retransmit_request').length, 0);
  clock.advance(1);
  const reqs = events.filter((e) => e.event === 'retransmit_request');
  assert.equal(reqs.length, 1);
  assert.deepEqual({ offset: reqs[0].offset, len: reqs[0].len }, { offset: 0, len: 100 });
  // Filling the gap stops further requests.
  gw.feed(data(1, 1, { offset: 0, payload: payloadOf(100) }));
  clock.advance(5000);
  assert.equal(events.filter((e) => e.event === 'retransmit_request').length, 1);
});

test('paused virtual clock suspends retransmit timeouts', () => {
  const { gw, clock, events } = makeGateway();
  gw.feed(data(1, 1, { offset: 10, payload: payloadOf(10) }));
  clock.pause();
  clock.advance(100000); // paused: time does not move
  assert.equal(events.filter((e) => e.event === 'retransmit_request').length, 0);
  clock.resume();
  clock.advance(1000);
  assert.equal(events.filter((e) => e.event === 'retransmit_request').length, 1);
});

test('END with gaps and overlapping mismatched fragments are structural errors', () => {
  const { gw } = makeGateway();
  gw.feed(data(1, 1, { offset: 10, payload: payloadOf(10) }));
  assert.throws(() => gw.feed(encode({ type: TYPE.END, board: 1, session: 1 })),
    (e) => e.code === 'end_with_gaps');

  const { gw: gw2 } = makeGateway();
  gw2.feed(data(2, 1, { offset: 0, payload: payloadOf(10) }));
  assert.throws(() => gw2.feed(data(2, 1, { offset: 5, payload: payloadOf(10, 1) })),
    (e) => e.code === 'overlap_mismatch');
});

test('incremental feed across arbitrary chunk boundaries', () => {
  const payload = payloadOf(300);
  const stream = Buffer.concat([
    data(1, 1, { offset: 150, payload: payload.subarray(150) }),
    data(1, 1, { offset: 0, payload: payload.subarray(0, 150) }),
    encode({ type: TYPE.END, board: 1, session: 1 }),
  ]);
  const { gw } = makeGateway();
  for (let i = 0; i < stream.length; i += 7) {
    gw.feed(stream.subarray(i, Math.min(i + 7, stream.length)));
  }
  gw.end();
  assert.equal(gw.certs()[0].merkleRoot, merkleRoot(payload));
});
