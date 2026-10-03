'use strict';

const { crc32 } = require('./crc32');

const MAGIC = 0xAA55;
const HEADER_SIZE = 13;
const CRC_SIZE = 4;
const MAX_PAYLOAD = 0xFFFF;

const TYPE = Object.freeze({ DATA: 0x01, END: 0x02, ABORT: 0x03 });
const TYPE_NAME = Object.freeze({ 1: 'DATA', 2: 'END', 3: 'ABORT' });

class StructuralError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StructuralError';
    this.code = code;
  }
}

function encode({ type, board, session, offset = 0, payload = Buffer.alloc(0), corruptCrc = false }) {
  if (!TYPE_NAME[type]) throw new RangeError(`unknown frame type ${type}`);
  if (payload.length > MAX_PAYLOAD) throw new RangeError('payload too large');
  const len = payload.length;
  const buf = Buffer.alloc(HEADER_SIZE + len + CRC_SIZE);
  buf.writeUInt16BE(MAGIC, 0);
  buf.writeUInt16BE(len, 2);
  buf.writeUInt8(type, 4);
  buf.writeUInt16BE(board, 5);
  buf.writeUInt16BE(session, 7);
  buf.writeUInt32BE(offset >>> 0, 9);
  payload.copy(buf, HEADER_SIZE);
  let crc = crc32(buf.subarray(0, HEADER_SIZE + len));
  if (corruptCrc) crc = (crc ^ 0xFFFFFFFF) >>> 0;
  buf.writeUInt32BE(crc, HEADER_SIZE + len);
  return buf;
}

// Returns { frame, size } or null when more bytes are needed.
// Throws StructuralError on malformed headers.
function parse(buffer) {
  if (buffer.length < 2) return null;
  const magic = buffer.readUInt16BE(0);
  if (magic !== MAGIC) {
    throw new StructuralError('bad_magic', `expected magic 0xAA55, got 0x${magic.toString(16).padStart(4, '0')}`);
  }
  if (buffer.length < HEADER_SIZE) return null;
  const len = buffer.readUInt16BE(2);
  const type = buffer.readUInt8(4);
  const typeName = TYPE_NAME[type];
  if (!typeName) {
    throw new StructuralError('unknown_type', `unknown frame type 0x${type.toString(16)}`);
  }
  if (type === TYPE.DATA && len === 0) {
    throw new StructuralError('empty_data', 'DATA frame must carry at least 1 payload byte');
  }
  if (type === TYPE.END && len !== 0) {
    throw new StructuralError('end_with_payload', 'END frame must not carry a payload');
  }
  const size = HEADER_SIZE + len + CRC_SIZE;
  if (buffer.length < size) return null;
  const expected = buffer.readUInt32BE(size - CRC_SIZE);
  const actual = crc32(buffer.subarray(0, size - CRC_SIZE));
  const frame = {
    type,
    typeName,
    board: buffer.readUInt16BE(5),
    session: buffer.readUInt16BE(7),
    offset: buffer.readUInt32BE(9),
    payload: Buffer.from(buffer.subarray(HEADER_SIZE, HEADER_SIZE + len)),
    crcOk: actual === expected,
  };
  return { frame, size };
}

module.exports = { MAGIC, HEADER_SIZE, CRC_SIZE, TYPE, TYPE_NAME, StructuralError, encode, parse };
