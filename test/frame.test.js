import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/crc32.js';
import { FrameDecoder, FrameError, validateFrame } from '../src/frame.js';
import { frame } from '../testutil/sign.mjs';

test('crc32 matches the standard check vector', () => {
  assert.equal(crc32('123456789'), 'cbf43926');
});

test('decoder handles frames split across arbitrary chunks (分帧)', () => {
  const f1 = JSON.stringify(frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 1, price: 1, seq: 1 }));
  const f2 = JSON.stringify(frame({ op: 'match', clOrdId: 'M1', seq: 2 }));
  const wire = f1 + '\r\n\n' + f2; // also: CRLF, blank line, no trailing newline
  const d = new FrameDecoder();
  const out = [];
  for (const ch of wire) out.push(...d.push(ch)); // 1-byte chunks
  out.push(...d.end());
  assert.equal(out.length, 2);
  assert.equal(out[0].clOrdId, 'B1');
  assert.equal(out[1].clOrdId, 'M1');
});

test('decoder rejects a trailing partial frame at end()', () => {
  const d = new FrameDecoder();
  d.push('{"op":"new"');
  assert.throws(() => d.end(), FrameError);
});

test('validateFrame rejects bad crc, unknown fields, bad types, unknown op', () => {
  const good = frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 1, price: 1, seq: 1 });
  assert.doesNotThrow(() => validateFrame(good));
  assert.throws(() => validateFrame({ ...good, crc: '00000000' }), /crc mismatch/);
  assert.throws(() => validateFrame(frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 1, price: 1, seq: 1, bogus: 1 })), /unexpected field/);
  assert.throws(() => validateFrame(frame({ op: 'new', clOrdId: 'B1', side: 'hold', qty: 1, price: 1, seq: 1 })), /side/);
  assert.throws(() => validateFrame(frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 1.5, price: 1, seq: 1 })), /qty/);
  assert.throws(() => validateFrame(frame({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 1, price: -1, seq: 1 })), /price/);
  assert.throws(() => validateFrame(frame({ op: 'explode', clOrdId: 'X', seq: 1 })), /unknown op/);
  assert.throws(() => validateFrame(frame({ op: 'amend', clOrdId: 'A1', origId: 'B1', seq: 2 })), /qty and\/or price/);
  assert.throws(() => validateFrame(frame({ op: 'cancel', clOrdId: 'C1', seq: 2 })), /missing field: origId/);
});
