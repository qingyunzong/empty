'use strict';

const { crc16ccitt } = require('./crc16');
const {
  MAGIC_HI,
  MAGIC_LO,
  TYPE_NAMES,
  HEADER_LEN,
  MAX_PAYLOAD,
} = require('./frame');

// Streaming deframer. Tolerates sticky (concatenated) and half frames:
// feed arbitrary chunks via push(), complete frames come out in order.
// Any malformed byte produces { code, offset } with an absolute stream offset.
class Framer {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.base = 0; // absolute stream offset of buf[0]
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    const frames = [];
    for (;;) {
      if (this.buf.length === 0) break;
      if (this.buf[0] !== MAGIC_HI) {
        return { frames, error: { code: 'BAD_MAGIC', offset: this.base } };
      }
      if (this.buf.length < 2) break;
      if (this.buf[1] !== MAGIC_LO) {
        return { frames, error: { code: 'BAD_MAGIC', offset: this.base + 1 } };
      }
      if (this.buf.length < 3) break;
      const len = this.buf[2];
      if (len < 1 || len > MAX_PAYLOAD) {
        return { frames, error: { code: 'BAD_LEN', offset: this.base + 2 } };
      }
      const total = HEADER_LEN + len;
      if (this.buf.length < total) break; // half frame: wait for more bytes
      const frame = this.buf.subarray(0, total);
      const expectedCrc = (frame[3] << 8) | frame[4];
      const crcInput = Buffer.concat([frame.subarray(2, 3), frame.subarray(5)]);
      if (crc16ccitt(crcInput) !== expectedCrc) {
        return { frames, error: { code: 'BAD_CRC', offset: this.base } };
      }
      const type = frame[7];
      if (!TYPE_NAMES[type]) {
        return { frames, error: { code: 'UNKNOWN_TYPE', offset: this.base + 7 } };
      }
      const wo = frame.subarray(HEADER_LEN).toString('utf8');
      if (!/^[\x21-\x7e]+$/.test(wo)) {
        return { frames, error: { code: 'BAD_PAYLOAD', offset: this.base + HEADER_LEN } };
      }
      frames.push({
        offset: this.base,
        seq: frame[5],
        ack: frame[6],
        type,
        typeName: TYPE_NAMES[type],
        wo,
      });
      this.buf = this.buf.subarray(total);
      this.base += total;
    }
    return { frames, error: null };
  }

  // At end of input any leftover bytes are an incomplete frame.
  finish() {
    if (this.buf.length > 0) {
      return { code: 'TRUNCATED', offset: this.base };
    }
    return null;
  }
}

module.exports = { Framer };
