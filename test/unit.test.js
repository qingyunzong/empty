'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { crc32 } = require('../src/crc32');
const { encodeChunk, decodeChunk, chunkHash, HEADER_LEN } = require('../src/chunk');
const { initialState, applyLayer } = require('../src/state');
const { BusinessError } = require('../src/errors');

test('crc32 matches the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('chunk encode/decode roundtrip', () => {
  const txs = [{ op: 'freeze', account: 'a', amount: 5, id: 'f1' }];
  const encoded = encodeChunk({ kind: 'freeze', seq: 7, parentHash: null, payload: { txs } });
  const { chunk, bytesRead } = decodeChunk(encoded, 0);
  assert.equal(bytesRead, encoded.length);
  assert.equal(chunk.kind, 'freeze');
  assert.equal(chunk.seq, 7);
  assert.equal(chunk.crcOk, true);
  assert.deepEqual(chunk.payload.txs, txs);
  assert.equal(chunk.hash, chunkHash(encoded));
  assert.match(chunk.parentHash, /^0{64}$/);
  assert.equal(chunk.length, HEADER_LEN + Buffer.byteLength(JSON.stringify({ txs })) + 4);
});

test('chunk detects crc corruption but stays scannable', () => {
  const encoded = encodeChunk({ kind: 'pay', seq: 3, parentHash: null, payload: { txs: [] } });
  const corrupted = Buffer.from(encoded);
  corrupted[HEADER_LEN] ^= 0xff;
  const { chunk, bytesRead } = decodeChunk(corrupted, 0);
  assert.equal(chunk.crcOk, false);
  assert.equal(bytesRead, encoded.length);
});

test('state machine: reserve/freeze/pay/revert semantics', () => {
  let s = initialState();
  s = applyLayer(s, 'reserve', [
    { op: 'credit', account: 'a', amount: 100, id: 'c1' },
    { op: 'reserve', account: 'a', amount: 40, id: 'r1' },
  ], 1);
  assert.deepEqual(s.accounts.a, { balance: 100, available: 100, reserved: 40, frozen: 0 });

  s = applyLayer(s, 'freeze', [{ op: 'freeze', account: 'a', amount: 30, id: 'f1' }], 2);
  assert.deepEqual(s.accounts.a, { balance: 100, available: 70, reserved: 40, frozen: 30 });

  s = applyLayer(s, 'pay', [{ op: 'pay', account: 'a', amount: 30, ref: 'f1', id: 'p1' }], 3);
  assert.deepEqual(s.accounts.a, { balance: 70, available: 70, reserved: 40, frozen: 0 });

  s = applyLayer(s, 'revert', [{ op: 'revert', ref: 'p1', id: 'rv1' }], 4);
  assert.deepEqual(s.accounts.a, { balance: 100, available: 70, reserved: 40, frozen: 30 });
  assert.equal(s.pays.p1.reverted, true);
  assert.equal(s.freezes.f1.paidBy, null);
});

test('state machine: layer is atomic on partial tx failure', () => {
  const s0 = applyLayer(initialState(), 'reserve', [{ op: 'credit', account: 'a', amount: 10, id: 'c1' }], 1);
  assert.throws(
    () => applyLayer(s0, 'freeze', [
      { op: 'freeze', account: 'a', amount: 5, id: 'f1' },
      { op: 'freeze', account: 'a', amount: 50, id: 'f2' },
    ], 2),
    BusinessError,
  );
  // original state untouched: no half-applied layer
  assert.deepEqual(s0.accounts.a, { balance: 10, available: 10, reserved: 0, frozen: 0 });
  assert.deepEqual(s0.freezes, {});
});

test('state machine: revert rules', () => {
  let s = initialState();
  s = applyLayer(s, 'reserve', [{ op: 'credit', account: 'a', amount: 100, id: 'c1' }], 1);
  s = applyLayer(s, 'freeze', [{ op: 'freeze', account: 'a', amount: 10, id: 'f1' }], 2);
  s = applyLayer(s, 'pay', [{ op: 'pay', account: 'a', amount: 10, ref: 'f1', id: 'p1' }], 3);

  // cannot revert a pay at or before the last checkpoint
  s.lastCheckpointSeq = 3;
  assert.throws(() => applyLayer(s, 'revert', [{ op: 'revert', ref: 'p1', id: 'rv' }], 4), /checkpoint/);

  // unknown pay
  s.lastCheckpointSeq = 0;
  assert.throws(() => applyLayer(s, 'revert', [{ op: 'revert', ref: 'nope', id: 'rv' }], 4), /unknown pay/);

  // pay without freeze link is rejected
  assert.throws(
    () => applyLayer(s, 'pay', [{ op: 'pay', account: 'a', amount: 1, ref: 'ghost', id: 'p2' }], 4),
    /unknown freeze link/,
  );
});
