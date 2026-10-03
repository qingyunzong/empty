'use strict';

const { crc16 } = require('./crc16');

const MAGIC = 0x5747; // 'WG'
const HEADER_LEN = 13; // magic(2) len(2) type(1) seq(4) ack(4)
const CRC_LEN = 2;
const MAX_PAYLOAD = 4096;

const TYPE = Object.freeze({ WELD_START: 0x01, WELD_END: 0x02, UNDO: 0x03 });
const TYPE_NAME = new Map(Object.entries(TYPE).map(([name, code]) => [code, name]));

class ParseError extends Error {
  constructor(code, offset) {
    super(`${code} at offset ${offset}`);
    this.name = 'ParseError';
    this.code = code;
    this.offset = offset;
  }
}

function encodeFrame({ type, seq = 0, ack = 0, payload = {} }) {
  const typeCode = typeof type === 'string' ? TYPE[type] : type;
  if (typeCode === undefined) throw new Error(`unknown frame type: ${type}`);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_PAYLOAD) throw new Error('payload too large');
  const head = Buffer.alloc(HEADER_LEN);
  head.writeUInt16BE(MAGIC, 0);
  head.writeUInt16BE(body.length, 2);
  head.writeUInt8(typeCode, 4);
  head.writeUInt32BE(seq >>> 0, 5);
  head.writeUInt32BE(ack >>> 0, 9);
  const framed = Buffer.concat([head, body]);
  const tail = Buffer.alloc(CRC_LEN);
  tail.writeUInt16BE(crc16(framed), 0);
  return Buffer.concat([framed, tail]);
}

// Decodes a crc-verified frame body (header + payload, no crc bytes).
function decodeBody(body, offset) {
  const type = body.readUInt8(4);
  if (!TYPE_NAME.has(type)) throw new ParseError('UNKNOWN_TYPE', offset + 4);
  const len = body.readUInt16BE(2);
  let payload = {};
  if (len > 0) {
    try {
      payload = JSON.parse(body.subarray(HEADER_LEN, HEADER_LEN + len).toString('utf8'));
    } catch {
      throw new ParseError('BAD_PAYLOAD', offset + HEADER_LEN);
    }
  }
  return {
    type,
    typeName: TYPE_NAME.get(type),
    seq: body.readUInt32BE(5),
    ack: body.readUInt32BE(9),
    payload,
    offset,
  };
}

module.exports = { MAGIC, HEADER_LEN, CRC_LEN, MAX_PAYLOAD, TYPE, TYPE_NAME, ParseError, encodeFrame, decodeBody };
