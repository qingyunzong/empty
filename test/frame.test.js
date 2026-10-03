'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encode, parse, TYPE, StructuralError, HEADER_SIZE } = require('../lib/frame');
const { crc32 } = require('../lib/crc32');

test('crc32 matches known IEEE vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('encode/parse roundtrip for DATA, END, ABORT', () => {
  const data = encode({ type: TYPE.DATA, board: 7, session: 3, offset: 42, payload: Buffer.from('hello') });
  const { frame, size } = parse(data);
  assert.equal(size, data.length);
  assert.deepEqual(
    { type: frame.type, board: frame.board, session: frame.session, offset: frame.offset, crcOk: frame.crcOk },
    { type: TYPE.DATA, board: 7, session: 3, offset: 42, crcOk: true },
  );
  assert.equal(frame.payload.toString(), 'hello');

  const end = parse(encode({ type: TYPE.END, board: 1, session: 1 })).frame;
  assert.equal(end.typeName, 'END');
  const abort = parse(encode({ type: TYPE.ABORT, board: 1, session: 1, payload: Buffer.from('jam') })).frame;
  assert.equal(abort.payload.toString(), 'jam');
});

test('corrupted crc is reported, not thrown', () => {
  const buf = encode({ type: TYPE.DATA, board: 1, session: 1, offset: 0, payload: Buffer.from('x'), corruptCrc: true });
  assert.equal(parse(buf).frame.crcOk, false);
});

test('bad magic is a structural error', () => {
  const buf = encode({ type: TYPE.END, board: 1, session: 1 });
  buf[0] = 0x00;
  assert.throws(() => parse(buf), (e) => e instanceof StructuralError && e.code === 'bad_magic');
});

test('unknown type is a structural error', () => {
  const buf = encode({ type: TYPE.END, board: 1, session: 1 });
  buf[4] = 0x7F;
  assert.throws(() => parse(buf), (e) => e.code === 'unknown_type');
});

test('END with payload and empty DATA are structural errors', () => {
  assert.throws(() => parse(encode({ type: TYPE.END, board: 1, session: 1, payload: Buffer.from('x') })),
    (e) => e.code === 'end_with_payload');
  assert.throws(() => parse(encode({ type: TYPE.DATA, board: 1, session: 1, offset: 0 })),
    (e) => e.code === 'empty_data');
});

test('incomplete frames return null until enough bytes arrive', () => {
  const buf = encode({ type: TYPE.DATA, board: 1, session: 1, offset: 0, payload: Buffer.from('abcdef') });
  assert.equal(parse(buf.subarray(0, 1)), null);
  assert.equal(parse(buf.subarray(0, HEADER_SIZE)), null);
  assert.equal(parse(buf.subarray(0, buf.length - 1)), null);
  assert.ok(parse(buf));
});
