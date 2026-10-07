import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import {
  BLOCK_TYPE,
  encodeBlock,
  parseBlock,
  encodeIndex,
  parseIndex,
  encodeTrailer,
  parseTrailer,
  encodeFileHeader,
  checkFileHeader,
} from '../src/format.js';
import { decodeBuffer, IncrementalDecoder } from '../src/reader.js';
import { E_FORMAT } from '../src/errors.js';

test('crc32 matches the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')) >>> 0, 0xcbf43926);
});

test('block encode/parse round-trips with crcOk', () => {
  const payload = Buffer.from('hello 包装', 'utf8');
  const raw = encodeBlock(BLOCK_TYPE.RECORDS, 7, payload);
  const parsed = parseBlock(raw);
  assert.equal(parsed.type, BLOCK_TYPE.RECORDS);
  assert.equal(parsed.version, 7);
  assert.equal(parsed.crcOk, true);
  assert.deepStrictEqual(Buffer.from(parsed.payload), payload);

  const flipped = Buffer.from(raw);
  flipped[12] ^= 0x01;
  assert.equal(parseBlock(flipped).crcOk, false);
});

test('index and trailer round-trip', () => {
  const entries = [
    { offset: 8, length: 50, type: BLOCK_TYPE.DICT, version: 1 },
    { offset: 58, length: 99, type: BLOCK_TYPE.RECORDS, version: 1 },
  ];
  const indexRaw = encodeIndex(entries);
  assert.deepStrictEqual(parseIndex(indexRaw), entries);
  const trailer = encodeTrailer(157);
  assert.deepStrictEqual(parseTrailer(trailer), { indexOffset: 157 });

  const badIndex = Buffer.from(indexRaw);
  badIndex[9] ^= 0x02;
  assert.throws(() => parseIndex(badIndex), /crc/);
});

test('file header validation rejects bad magic and version', () => {
  const header = encodeFileHeader();
  assert.doesNotThrow(() => checkFileHeader(header));
  const bad = Buffer.from(header);
  bad[0] = 0x58;
  assert.throws(() => checkFileHeader(bad), /magic/);
  const badVer = Buffer.from(header);
  badVer.writeUInt16LE(99, 4);
  assert.throws(() => checkFileHeader(badVer), /version/);
});

test('decoder reports a truncated stream as E_FORMAT on end()', () => {
  const raw = encodeBlock(BLOCK_TYPE.DICT, 1, Buffer.from('x'));
  const header = encodeFileHeader();
  const decoder = new IncrementalDecoder();
  decoder.push(Buffer.concat([header, raw.subarray(0, raw.length - 3)]));
  const events = decoder.end();
  assert.ok(events.some((e) => e.type === 'error' && e.code === E_FORMAT));
});

test('decodeBuffer emits an index event with all entries', () => {
  const header = encodeFileHeader();
  const block = encodeBlock(BLOCK_TYPE.DICT, 1, Buffer.alloc(12));
  const index = encodeIndex([{ offset: 8, length: block.length, type: BLOCK_TYPE.DICT, version: 1 }]);
  const trailer = encodeTrailer(8 + block.length);
  const events = decodeBuffer(Buffer.concat([header, block, index, trailer]));
  const idx = events.find((e) => e.type === 'index');
  assert.equal(idx.entries.length, 1);
  assert.equal(idx.entries[0].version, 1);
});
