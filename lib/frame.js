'use strict';

// Wire format (little endian):
//   [u32 bodyLen][JSON body {authId,type,amount,seq,ack}][8-byte mac]
// mac = HMAC-SHA256(key, len||body) truncated to 8 bytes.
// The length prefix lets the parser reassemble frames that were split
// into arbitrary physical chunks (fragmentation / 分帧).

const crypto = require('node:crypto');

const TYPES = new Set(['hold', 'inc', 'dec', 'complete', 'void', 'reverse']);
const MAC_LEN = 8;
const HEADER_LEN = 4;

function canonical(frame) {
  return JSON.stringify({
    authId: frame.authId,
    type: frame.type,
    amount: frame.amount,
    seq: frame.seq,
    ack: frame.ack,
  });
}

function computeMac(key, buf) {
  return crypto.createHmac('sha256', key).update(buf).digest().subarray(0, MAC_LEN);
}

function encodeFrame(frame, key) {
  const body = Buffer.from(canonical(frame), 'utf8');
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32LE(body.length, 0);
  const mac = computeMac(key, Buffer.concat([header, body]));
  return Buffer.concat([header, body, mac]);
}

function encodeStream(frames, key) {
  return Buffer.concat(frames.map((f) => encodeFrame(f, key)));
}

function validateFrame(frame) {
  if (frame === null || typeof frame !== 'object') return 'frame is not an object';
  if (typeof frame.authId !== 'string' || frame.authId.length === 0) return 'bad authId';
  if (!TYPES.has(frame.type)) return `bad type: ${frame.type}`;
  if (!Number.isInteger(frame.amount) || frame.amount < 0) return 'bad amount';
  if (!Number.isInteger(frame.seq) || frame.seq < 1) return 'bad seq';
  if (!Number.isInteger(frame.ack) || frame.ack < 0) return 'bad ack';
  return null;
}

// Incremental parser: push() arbitrary chunks, get back complete records.
// Each record: { frame, macOk, offset }.
class FrameParser {
  constructor(key) {
    this.key = key;
    this.buf = Buffer.alloc(0);
    this.offset = 0; // stream offset of buf[0]
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      if (this.buf.length < HEADER_LEN) break;
      const bodyLen = this.buf.readUInt32LE(0);
      const total = HEADER_LEN + bodyLen + MAC_LEN;
      if (this.buf.length < total) break;
      const signed = this.buf.subarray(0, HEADER_LEN + bodyLen);
      const body = this.buf.subarray(HEADER_LEN, HEADER_LEN + bodyLen);
      const mac = this.buf.subarray(HEADER_LEN + bodyLen, total);
      const expected = computeMac(this.key, signed);
      let frame = null;
      let parseOk = true;
      try {
        frame = JSON.parse(body.toString('utf8'));
      } catch {
        parseOk = false;
      }
      out.push({
        frame,
        macOk: parseOk && mac.equals(expected),
        offset: this.offset,
      });
      this.buf = this.buf.subarray(total);
      this.offset += total;
    }
    return out;
  }

  get pendingBytes() {
    return this.buf.length;
  }
}

module.exports = { TYPES, MAC_LEN, canonical, computeMac, encodeFrame, encodeStream, validateFrame, FrameParser };
