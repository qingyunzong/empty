'use strict';

const crypto = require('node:crypto');

const MAGIC = Buffer.from([0x50, 0x41]);
const VERSION = 1;
const FLAG_MORE = 0x01;
const HEADER_LEN = 8;
const MAC_LEN = 8;

class MacError extends Error {
  constructor(message) {
    super(message);
    this.code = 'MAC_ERROR';
    this.exitCode = 2;
  }
}

function macFor(key, bytes) {
  return crypto.createHmac('sha256', key).update(bytes).digest().subarray(0, MAC_LEN);
}

function buildChunk(key, payload, flags) {
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header[2] = VERSION;
  header[3] = flags;
  header.writeUInt32BE(payload.length, 4);
  const body = Buffer.concat([header, payload]);
  return Buffer.concat([body, macFor(key, body)]);
}

function encodeFrame(message, { key, fragmentSize = 0 } = {}) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (!fragmentSize || payload.length <= fragmentSize) {
    return buildChunk(key, payload, 0);
  }
  const parts = [];
  for (let off = 0; off < payload.length; off += fragmentSize) {
    const slice = payload.subarray(off, Math.min(off + fragmentSize, payload.length));
    const more = off + fragmentSize < payload.length ? FLAG_MORE : 0;
    parts.push(buildChunk(key, slice, more));
  }
  return Buffer.concat(parts);
}

function encodeStream(messages, options = {}) {
  return Buffer.concat(messages.map((m) => encodeFrame(m, options)));
}

class FrameParser {
  constructor(key) {
    this.key = key;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const messages = [];
    for (;;) {
      if (this.buf.length < HEADER_LEN) break;
      if (!this.buf.subarray(0, 2).equals(MAGIC)) throw new MacError('bad magic');
      if (this.buf[2] !== VERSION) throw new MacError(`unsupported version ${this.buf[2]}`);
      const flags = this.buf[3];
      const len = this.buf.readUInt32BE(4);
      const total = HEADER_LEN + len + MAC_LEN;
      if (this.buf.length < total) break;
      const body = this.buf.subarray(0, HEADER_LEN + len);
      const mac = this.buf.subarray(HEADER_LEN + len, total);
      const expect = macFor(this.key, body);
      if (!crypto.timingSafeEqual(mac, expect)) throw new MacError('mac mismatch');
      const payload = this.buf.subarray(HEADER_LEN, HEADER_LEN + len);
      this.buf = this.buf.subarray(total);
      if (flags & FLAG_MORE) {
        this.fragments.push(payload);
        continue;
      }
      const full = this.fragments.length > 0 ? Buffer.concat([...this.fragments, payload]) : payload;
      this.fragments = [];
      messages.push(JSON.parse(full.toString('utf8')));
    }
    return messages;
  }

  end() {
    if (this.buf.length > 0) throw new MacError('truncated frame at end of stream');
    if (this.fragments.length > 0) throw new MacError('unterminated fragment chain');
  }
}

module.exports = { encodeFrame, encodeStream, FrameParser, MacError, FLAG_MORE, MAC_LEN, HEADER_LEN };
