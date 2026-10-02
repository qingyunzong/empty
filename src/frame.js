'use strict';

const { crc32 } = require('./crc32');
const { ProtocolError } = require('./errors');

// Frame layout (all integers big-endian):
//   u16  body length (everything after these 2 bytes, CRC included)
//   u16  magic   = 0xCB5E
//   u8   version = 1
//   u8   type    (1 = DATA, 2 = ACK)
//   u32  batchId
//   u16  lineNo  (0 on ACK frames)
//   u16  seq     (per-batch, 1-based)
//   u16  ack     (next expected seq, cumulative)
//   u8   flags   (bit0 = EOB end-of-batch, bit1 = reversal)
//   u8[] payload (canonical JSON of the settlement line on DATA frames)
//   u32  CRC-32 over all preceding body bytes
const MAGIC = 0xcb5e;
const VERSION = 1;
const TYPE_DATA = 1;
const TYPE_ACK = 2;
const FLAG_EOB = 1;
const FLAG_REVERSAL = 2;
const HEADER_LEN = 15;
const CRC_LEN = 4;
const MIN_BODY = HEADER_LEN + CRC_LEN;
const MAX_BODY = 65535;

function encodeFrame({ type, batchId, lineNo = 0, seq = 0, ack = 0, flags = 0, payload = Buffer.alloc(0) }) {
  const body = Buffer.alloc(HEADER_LEN + payload.length + CRC_LEN);
  body.writeUInt16BE(MAGIC, 0);
  body.writeUInt8(VERSION, 2);
  body.writeUInt8(type, 3);
  body.writeUInt32BE(batchId >>> 0, 4);
  body.writeUInt16BE(lineNo, 8);
  body.writeUInt16BE(seq, 10);
  body.writeUInt16BE(ack, 12);
  body.writeUInt8(flags, 14);
  payload.copy(body, HEADER_LEN);
  body.writeUInt32BE(crc32(body.subarray(0, body.length - CRC_LEN)), body.length - CRC_LEN);
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

// Parses as many complete frames as possible. A trailing half frame is kept
// in `rest` for reassembly. CRC mismatches are recoverable: the frame is
// skipped (its length is known) and reported in `errors`. Bad magic or
// version with a valid CRC is an unrecoverable ProtocolError.
function parseFrames(buf) {
  const frames = [];
  const errors = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const len = buf.readUInt16BE(off);
    if (len < MIN_BODY || len > MAX_BODY) throw new ProtocolError(`invalid frame length ${len}`);
    if (buf.length - off < 2 + len) break;
    const body = buf.subarray(off + 2, off + 2 + len);
    off += 2 + len;
    const stored = body.readUInt32BE(len - CRC_LEN);
    const calc = crc32(body.subarray(0, len - CRC_LEN));
    if (stored !== calc) {
      errors.push({ code: 'CRC_MISMATCH' });
      continue;
    }
    if (body.readUInt16BE(0) !== MAGIC) throw new ProtocolError('bad magic');
    if (body.readUInt8(2) !== VERSION) throw new ProtocolError(`unsupported version ${body.readUInt8(2)}`);
    frames.push({
      type: body.readUInt8(3),
      batchId: body.readUInt32BE(4),
      lineNo: body.readUInt16BE(8),
      seq: body.readUInt16BE(10),
      ack: body.readUInt16BE(12),
      flags: body.readUInt8(14),
      payload: Buffer.from(body.subarray(HEADER_LEN, len - CRC_LEN)),
    });
  }
  return { frames, rest: buf.subarray(off), errors };
}

module.exports = {
  MAGIC, VERSION, TYPE_DATA, TYPE_ACK, FLAG_EOB, FLAG_REVERSAL,
  HEADER_LEN, CRC_LEN, encodeFrame, parseFrames,
};
