'use strict';

const { crc16ccitt } = require('./crc16');

const MAGIC_HI = 0xAB;
const MAGIC_LO = 0xCD;

const TYPES = Object.freeze({
  WELD_START: 0x01,
  WELD_END: 0x02,
  UNDO: 0x03,
});

const TYPE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(TYPES).map(([name, code]) => [code, name]))
);

// magic(2) + len(1) + crc16(2) + seq(1) + ack(1) + type(1)
const HEADER_LEN = 8;
const MAX_PAYLOAD = 64;

// Frame layout on the wire:
//   [0]   0xAB
//   [1]   0xCD
//   [2]   len          payload length in bytes (1..MAX_PAYLOAD)
//   [3-4] crc16        big-endian, over [len, seq, ack, type, payload...]
//   [5]   seq
//   [6]   ack
//   [7]   type
//   [8..] payload      work-order id, printable ASCII
function encodeFrame({ seq, ack = 0, type, payload }) {
  const typeCode = typeof type === 'string' ? TYPES[type] : type;
  if (typeCode === undefined) throw new Error(`unknown frame type: ${type}`);
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (body.length < 1 || body.length > MAX_PAYLOAD) {
    throw new Error(`payload length out of range: ${body.length}`);
  }
  const head = Buffer.from([body.length, seq & 0xFF, ack & 0xFF, typeCode]);
  const crc = crc16ccitt(Buffer.concat([head.subarray(0, 1), head.subarray(1), body]));
  // crc input is [len, seq, ack, type, payload]; head already is [len, seq, ack, type]
  const frame = Buffer.alloc(HEADER_LEN + body.length);
  frame[0] = MAGIC_HI;
  frame[1] = MAGIC_LO;
  frame[2] = body.length;
  frame[3] = (crc >> 8) & 0xFF;
  frame[4] = crc & 0xFF;
  frame[5] = seq & 0xFF;
  frame[6] = ack & 0xFF;
  frame[7] = typeCode;
  body.copy(frame, HEADER_LEN);
  return frame;
}

module.exports = {
  MAGIC_HI,
  MAGIC_LO,
  TYPES,
  TYPE_NAMES,
  HEADER_LEN,
  MAX_PAYLOAD,
  encodeFrame,
};
