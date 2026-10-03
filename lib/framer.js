'use strict';

const { MAGIC, HEADER_LEN, CRC_LEN, MAX_PAYLOAD, ParseError, decodeBody } = require('./frame');
const { crc16 } = require('./crc16');

// Incremental byte-stream framer. Tolerates sticky (concatenated) frames and
// half frames: push() any chunk size, end() flushes and validates the tail.
class Framer {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.base = 0; // absolute stream offset of buf[0]
    this.frames = []; // frames parsed since last push/end (survive errors)
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this._drain(false);
    return this.frames.splice(0);
  }

  end() {
    this._drain(true);
    return this.frames.splice(0);
  }

  _drain(final) {
    for (;;) {
      if (this.buf.length >= 2 && this.buf.readUInt16BE(0) !== MAGIC) {
        throw new ParseError('BAD_MAGIC', this.base);
      }
      if (this.buf.length < HEADER_LEN) {
        if (final && this.buf.length > 0) throw new ParseError('TRUNCATED_FRAME', this.base);
        return;
      }
      const len = this.buf.readUInt16BE(2);
      if (len > MAX_PAYLOAD) throw new ParseError('LEN_TOO_LARGE', this.base + 2);
      const total = HEADER_LEN + len + CRC_LEN;
      if (this.buf.length < total) {
        if (final) throw new ParseError('TRUNCATED_FRAME', this.base);
        return;
      }
      const body = this.buf.subarray(0, HEADER_LEN + len);
      const expectedCrc = this.buf.readUInt16BE(HEADER_LEN + len);
      if (crc16(body) !== expectedCrc) {
        throw new ParseError('CRC_MISMATCH', this.base + HEADER_LEN + len);
      }
      this.frames.push(decodeBody(body, this.base));
      this.buf = this.buf.subarray(total);
      this.base += total;
    }
  }
}

module.exports = { Framer };
