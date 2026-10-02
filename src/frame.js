'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { canonical, sha256hex, hmac256hex } = require('./canon');
const { frameError } = require('./errors');

// Wire format (all integers big-endian):
//   magic   2 bytes  'P' 'K' (0x50 0x4b)
//   length  2 bytes  payload byte length
//   payload N bytes  canonical JSON of the event (includes id and sig)
//   crc32   4 bytes  CRC-32 of the payload (node:zlib.crc32)
const MAGIC = Buffer.from([0x50, 0x4b]);
const HEADER_LEN = 4;
const CRC_LEN = 4;
const MAX_PAYLOAD = 0xffff;

const KINDS = new Set(['PACK', 'REWORK', 'SCRAP', 'CORRECT']);
const HEX64 = /^[0-9a-f]{64}$/;
const SIG_DOMAIN = 'packline-sig/1';
const ID_DOMAIN = 'packline-event/1';

const SIGNED_FIELDS = ['batch', 'item', 'seq', 'lamport', 'kind', 'ref', 'qty', 'reason'];
const WIRE_FIELDS = new Set([...SIGNED_FIELDS, 'id', 'sig']);

const DEFAULT_KEY = 'packline-offline-default-key';

function resolveKey(key) {
  return key || process.env.PACKLINE_HMAC_KEY || DEFAULT_KEY;
}

function eventId(fields) {
  const signed = {};
  for (const name of SIGNED_FIELDS) signed[name] = fields[name];
  return sha256hex(ID_DOMAIN + '\n' + canonical(signed));
}

function signEvent(fields, key) {
  const id = eventId(fields);
  const sig = hmac256hex(resolveKey(key), SIG_DOMAIN + '\n' + id);
  return { ...fields, id, sig };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateFields(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw frameError('event payload must be an object');
  }
  if (!isNonEmptyString(event.batch)) throw frameError('event.batch must be a non-empty string');
  if (!isNonEmptyString(event.item)) throw frameError('event.item must be a non-empty string');
  if (!isNonNegInt(event.seq)) throw frameError('event.seq must be a non-negative integer');
  if (!isNonNegInt(event.lamport)) throw frameError('event.lamport must be a non-negative integer');
  if (!KINDS.has(event.kind)) {
    throw frameError('event.kind must be one of ' + [...KINDS].join(','));
  }
  if (!(event.ref === null || (typeof event.ref === 'string' && HEX64.test(event.ref)))) {
    throw frameError('event.ref must be null or a 64-char hex event id');
  }
  if (!isNonNegInt(event.qty)) throw frameError('event.qty must be a non-negative integer');
  if (!(event.reason === null || typeof event.reason === 'string')) {
    throw frameError('event.reason must be null or a string');
  }
  if (event.kind === 'CORRECT') {
    if (event.ref === null) throw frameError('CORRECT event requires ref');
    if (!isNonEmptyString(event.reason)) throw frameError('CORRECT event requires a reason');
  } else if (event.ref !== null) {
    throw frameError(event.kind + ' event must not carry ref');
  }
}

function decodeEvent(obj, key) {
  validateFields(obj);
  for (const name of Object.keys(obj)) {
    if (!WIRE_FIELDS.has(name)) throw frameError('unexpected event field: ' + name);
  }
  if (typeof obj.id !== 'string' || !HEX64.test(obj.id)) {
    throw frameError('event.id must be a 64-char hex string');
  }
  const id = eventId(obj);
  if (obj.id !== id) throw frameError('event id does not match event content');
  if (typeof obj.sig !== 'string' || !HEX64.test(obj.sig)) {
    throw frameError('event.sig must be a 64-char hex string');
  }
  const expected = Buffer.from(hmac256hex(resolveKey(key), SIG_DOMAIN + '\n' + id), 'hex');
  const actual = Buffer.from(obj.sig, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw frameError('event signature mismatch');
  }
  return {
    batch: obj.batch,
    item: obj.item,
    seq: obj.seq,
    lamport: obj.lamport,
    kind: obj.kind,
    ref: obj.ref,
    qty: obj.qty,
    reason: obj.reason,
    id,
    sig: obj.sig,
  };
}

function encodeFrame(fields, key) {
  const event = signEvent(fields, key);
  const payload = Buffer.from(canonical(event), 'utf8');
  if (payload.length > MAX_PAYLOAD) throw frameError('event payload too large');
  const frame = Buffer.alloc(HEADER_LEN + payload.length + CRC_LEN);
  MAGIC.copy(frame, 0);
  frame.writeUInt16BE(payload.length, 2);
  payload.copy(frame, HEADER_LEN);
  frame.writeUInt32BE(zlib.crc32(payload) >>> 0, HEADER_LEN + payload.length);
  return frame;
}

// Streaming decoder: tolerant of arbitrary chunking (fragmentation) of the
// input byte stream. push() returns every frame completed so far; end()
// rejects a truncated tail.
class FrameDecoder {
  #buf = Buffer.alloc(0);
  #key;

  constructor({ key } = {}) {
    this.#key = key;
  }

  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : Buffer.from(chunk);
    const events = [];
    for (;;) {
      if (this.#buf.length < HEADER_LEN) break;
      if (this.#buf[0] !== MAGIC[0] || this.#buf[1] !== MAGIC[1]) {
        throw frameError('bad frame magic');
      }
      const len = this.#buf.readUInt16BE(2);
      const total = HEADER_LEN + len + CRC_LEN;
      if (this.#buf.length < total) break;
      const payload = this.#buf.subarray(HEADER_LEN, HEADER_LEN + len);
      const crc = this.#buf.readUInt32BE(HEADER_LEN + len);
      if ((zlib.crc32(payload) >>> 0) !== crc) throw frameError('frame crc mismatch');
      let obj;
      try {
        obj = JSON.parse(payload.toString('utf8'));
      } catch {
        throw frameError('frame payload is not valid JSON');
      }
      events.push(decodeEvent(obj, this.#key));
      this.#buf = this.#buf.subarray(total);
    }
    return events;
  }

  end() {
    if (this.#buf.length !== 0) throw frameError('truncated trailing frame');
  }
}

module.exports = { KINDS, signEvent, eventId, encodeFrame, FrameDecoder, decodeEvent };
