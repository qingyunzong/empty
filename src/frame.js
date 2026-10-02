'use strict';

const { crc32 } = require('./crc32');

// Wire format (all integers big-endian):
//   0  u8   magic0 = 0xC7
//   1  u8   magic1 = 0x3B
//   2  u8   version = 1
//   3  u8   type (1 = DATA, 2 = ACK)
//   4  u32  batchId
//   8  u16  lineNo
//  10  u32  seq   (sender sequence number, DATA frames)
//  14  u32  ack   (cumulative: next expected seq, ACK frames)
//  18  u16  payloadLen
//  20  ...  payload (payloadLen bytes)
//  ..  u32  crc32 over header+payload
const MAGIC0 = 0xC7;
const MAGIC1 = 0x3B;
const VERSION = 1;
const HEADER_LEN = 20;
const CRC_LEN = 4;
const TYPE = { DATA: 1, ACK: 2 };

class ProtocolError extends Error {
  constructor(message, code = 'PROTOCOL_ERROR') {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function encode({ type, batchId, lineNo = 0, seq = 0, ack = 0, payload = Buffer.alloc(0) }) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  const body = Buffer.alloc(HEADER_LEN + payload.length);
  body[0] = MAGIC0;
  body[1] = MAGIC1;
  body[2] = VERSION;
  body[3] = type;
  body.writeUInt32BE(batchId >>> 0, 4);
  body.writeUInt16BE(lineNo & 0xFFFF, 8);
  body.writeUInt32BE(seq >>> 0, 10);
  body.writeUInt32BE(ack >>> 0, 14);
  body.writeUInt16BE(payload.length, 18);
  payload.copy(body, HEADER_LEN);
  const out = Buffer.alloc(body.length + CRC_LEN);
  body.copy(out, 0);
  out.writeUInt32BE(crc32(body), body.length);
  return out;
}

// Streaming decoder: tolerates frames split across arbitrary chunk boundaries,
// garbage between frames (resync via magic scan) and CRC-corrupted frames
// (dropped, then resync). A CRC-valid frame with an unknown version is a
// hard protocol error.
class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.stats = { crcErrors: 0, resyncs: 0 };
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    const frames = [];
    for (;;) {
      let start = -1;
      for (let k = 0; k + 1 < this.buf.length; k++) {
        if (this.buf[k] === MAGIC0 && this.buf[k + 1] === MAGIC1) { start = k; break; }
      }
      if (start === -1) {
        // Keep a trailing lone magic0 byte: it may be the start of a split magic.
        const last = this.buf.length > 0 && this.buf[this.buf.length - 1] === MAGIC0;
        this.buf = last ? this.buf.subarray(this.buf.length - 1) : Buffer.alloc(0);
        break;
      }
      if (start > 0) {
        this.stats.resyncs++;
        this.buf = this.buf.subarray(start);
      }
      if (this.buf.length < HEADER_LEN) break; // half frame: wait for more bytes
      const payloadLen = this.buf.readUInt16BE(18);
      const total = HEADER_LEN + payloadLen + CRC_LEN;
      if (this.buf.length < total) break; // half frame: wait for more bytes
      const body = this.buf.subarray(0, total - CRC_LEN);
      const expectedCrc = this.buf.readUInt32BE(total - CRC_LEN);
      if (crc32(body) !== expectedCrc) {
        this.stats.crcErrors++;
        this.buf = this.buf.subarray(2); // drop corrupt frame, rescan for next magic
        continue;
      }
      const frame = {
        version: this.buf[2],
        type: this.buf[3],
        batchId: this.buf.readUInt32BE(4),
        lineNo: this.buf.readUInt16BE(8),
        seq: this.buf.readUInt32BE(10),
        ack: this.buf.readUInt32BE(14),
        payload: Buffer.from(this.buf.subarray(HEADER_LEN, HEADER_LEN + payloadLen)),
      };
      this.buf = this.buf.subarray(total);
      if (frame.version !== VERSION) {
        throw new ProtocolError(`unsupported frame version ${frame.version}`, 'BAD_VERSION');
      }
      frames.push(frame);
    }
    return frames;
  }
}

module.exports = { encode, FrameDecoder, ProtocolError, TYPE, VERSION, MAGIC0, MAGIC1, HEADER_LEN };
