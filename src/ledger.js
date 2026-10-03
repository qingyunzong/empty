'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { crc32 } = require('./crc32');
const { CorruptError } = require('./errors');

const MAGIC = Buffer.from('GSB1', 'ascii');
const HEADER_SIZE = 60;
const TYPE_SNAPSHOT = 1;
const TYPE_DELTA = 2;
const ZERO_HASH = Buffer.alloc(32);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function encodeBlock({ version, type, offset, payload, prevHash }) {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(version, 4);
  header.writeUInt8(type, 8);
  header.writeBigUInt64BE(BigInt(offset), 12);
  header.writeUInt32BE(body.length, 20);
  header.writeUInt32BE(crc32(body), 24);
  Buffer.from(prevHash).copy(header, 28);
  return Buffer.concat([header, body]);
}

function readExact(fd, length, offset, what) {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, offset + read);
    if (n === 0) break;
    read += n;
  }
  if (read < length) {
    throw new CorruptError(`truncated ${what} at offset ${offset}`);
  }
  return buf;
}

// Returns null on clean EOF at `offset`; throws CorruptError on any corruption.
function decodeBlock(fd, offset) {
  const probe = Buffer.alloc(1);
  const n = fs.readSync(fd, probe, 0, 1, offset);
  if (n === 0) return null;
  const header = readExact(fd, HEADER_SIZE, offset, 'block header');
  if (!header.subarray(0, 4).equals(MAGIC)) {
    throw new CorruptError(`bad magic at offset ${offset}`);
  }
  const version = header.readUInt32BE(4);
  const type = header.readUInt8(8);
  if (type !== TYPE_SNAPSHOT && type !== TYPE_DELTA) {
    throw new CorruptError(`unknown block type ${type} at offset ${offset}`);
  }
  const blockOffset = Number(header.readBigUInt64BE(12));
  if (blockOffset !== offset) {
    throw new CorruptError(`offset mismatch at offset ${offset}: header says ${blockOffset}`);
  }
  const length = header.readUInt32BE(20);
  const crc = header.readUInt32BE(24);
  const prevHash = Buffer.from(header.subarray(28, 60));
  const payload = readExact(fd, length, offset + HEADER_SIZE, 'block payload');
  if (crc32(payload) !== crc) {
    throw new CorruptError(`CRC32 mismatch in block at offset ${offset} (version ${version})`);
  }
  const hash = sha256(Buffer.concat([header, payload]));
  return { version, type, offset, payload, prevHash, hash, size: HEADER_SIZE + length };
}

module.exports = {
  MAGIC,
  HEADER_SIZE,
  TYPE_SNAPSHOT,
  TYPE_DELTA,
  ZERO_HASH,
  sha256,
  encodeBlock,
  decodeBlock,
};
