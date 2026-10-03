'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { crc32 } = require('../lib/crc32');
const { TYPES, encodeFrame, decodeFrame, FrameError } = require('../lib/frame');
const { Reassembler, LinkError, fragmentFrame } = require('../lib/link');
const { computeNetting } = require('../lib/netting');
const { Engine } = require('../lib/engine');
const { obl, ack, tick } = require('./helpers');

test('crc32 matches the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('frame encode/decode roundtrip incl. negative amount', () => {
  const f = { type: TYPES.OBLIGATION, cycle: 3, from: 0, to: 2, ccy: 'EUR', amount: -42n, seq: 7, reason: 0 };
  const d = decodeFrame(encodeFrame(f));
  assert.deepEqual(d, f);
});

test('corrupted frame fails crc validation', () => {
  const buf = encodeFrame(obl(0, 0, 1, 'USD', 100, 1));
  buf[15] ^= 0xff;
  assert.throws(() => decodeFrame(buf), (e) => e instanceof FrameError && e.code === 'BAD_CRC' && e.exitCode === 2);
});

test('link reassembles fragmented, duplicated, out-of-order packets', () => {
  const f1 = encodeFrame(obl(0, 0, 1, 'USD', 100, 1));
  const f2 = encodeFrame(obl(0, 1, 2, 'EUR', 50, 1));
  const p1 = fragmentFrame(f1, 1, 7); // 5 fragments
  const p2 = fragmentFrame(f2, 2, 10); // 3 fragments
  const stream = Buffer.concat([
    p1[2], p2[0], p2[0], /* retransmission */ p1[0], p1[0], /* retransmission */
    p1[4], p2[2], p1[1], p2[1], p1[3],
  ]);
  const link = new Reassembler();
  const frames = link.feed(stream);
  assert.deepEqual(frames, [f2, f1]); // completion order
  assert.equal(link.warnings.length, 2); // both duplicates logged
  assert.deepEqual(decodeFrame(frames[0]), decodeFrame(f2));
  assert.deepEqual(decodeFrame(frames[1]), decodeFrame(f1));
});

test('link rejects malformed streams', () => {
  const link = new Reassembler();
  assert.throws(() => link.feed(Buffer.from('garbage!')), (e) => e instanceof LinkError && e.exitCode === 2);
  const good = fragmentFrame(encodeFrame(obl(0, 0, 1, 'USD', 1, 1)), 1, 29)[0];
  assert.throws(() => new Reassembler().feed(good.subarray(0, good.length - 3)), LinkError);
});

test('netting: basic gross matrix and net positions', () => {
  const { matrix, net } = computeNetting([
    { from: 0, to: 1, amount: 100n },
    { from: 0, to: 1, amount: 20n },
    { from: 1, to: 0, amount: 50n },
  ]);
  assert.equal(matrix.get('0->1'), 120n);
  assert.equal(matrix.get('1->0'), 50n);
  assert.equal(net.get(0), -70n);
  assert.equal(net.get(1), 70n);
});

test('engine: duplicate ack does not double-confirm (idempotent)', () => {
  const e = new Engine({ cycleMs: 60000 });
  e.ingest(obl(0, 0, 1, 'USD', 100, 1));
  const a = ack(0, 1, 0, 1);
  e.apply(a, 0); // bypass frame dedup to hit applyAck twice
  e.apply(a, 0);
  const kinds = e.events.map((x) => x.kind);
  assert.equal(kinds.filter((k) => k === 'ack').length, 1);
  assert.equal(kinds.filter((k) => k === 'ack-duplicate').length, 1);
  const oblRec = e.cycleState(0).obligations.get('0:1');
  assert.equal(oblRec.acked, true);
});

test('engine: identical retransmitted frame is deduped once', () => {
  const e = new Engine({ cycleMs: 60000 });
  e.ingest(obl(0, 0, 1, 'USD', 100, 1));
  e.ingest(obl(0, 0, 1, 'USD', 100, 1));
  e.ingest(tick(60000));
  const kinds = e.events.map((x) => x.kind);
  assert.equal(kinds.filter((k) => k === 'obligation').length, 1);
  assert.equal(kinds.filter((k) => k === 'duplicate-frame').length, 1);
});
