import fs from 'node:fs';
import { uvarintEncode, uvarintDecode, zigzagEncode, zigzagDecode } from './varint.js';
import { crc32 } from './crc32.js';
import { ioError } from './errors.js';

// Segment file layout:
//   magic "PLCS" (4B) | version (1B) | state (1B: 0=active,1=frozen)
//   | headerJsonLen varint | headerJson {id, createdAt}
//   | records...
// Record framing: len varint | payload | crc32(payload) 4B LE
// Payload kinds:
//   DICT  (0): scope(1B: 0=code,1=device) | strlen varint | utf8 bytes
//   EVENT (1): seq uvarint | tsDelta zigzag-varint | codeIdx uvarint | deviceIdx uvarint
// Dictionary strings are stored once per segment (dictionary compression);
// events reference dict indices, so positions inside the segment are stable
// and phrase-sequence queries can rely on event order.

export const MAGIC = Buffer.from([0x50, 0x4c, 0x43, 0x53]); // "PLCS"
export const VERSION = 1;
export const STATE_ACTIVE = 0;
export const STATE_FROZEN = 1;
export const STATE_OFFSET = 5;

const KIND_DICT = 0;
const KIND_EVENT = 1;
const DICT_CODE = 0;
const DICT_DEVICE = 1;

export function segmentHeaderBuffer(id, state) {
  const hj = Buffer.from(JSON.stringify({ id, createdAt: Date.now() }), 'utf8');
  return Buffer.concat([MAGIC, Buffer.from([VERSION, state]), uvarintEncode(hj.length), hj]);
}

function frame(payload) {
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(payload));
  return Buffer.concat([uvarintEncode(payload.length), payload, crc]);
}

export function encodeDictRecord(scope, value) {
  const s = Buffer.from(value, 'utf8');
  return frame(Buffer.concat([Buffer.from([KIND_DICT, scope]), uvarintEncode(s.length), s]));
}

export function encodeEventRecord(seq, tsDelta, codeIdx, deviceIdx) {
  return frame(Buffer.concat([
    Buffer.from([KIND_EVENT]),
    uvarintEncode(seq),
    uvarintEncode(zigzagEncode(tsDelta)),
    uvarintEncode(codeIdx),
    uvarintEncode(deviceIdx),
  ]));
}

// Incremental encoder for a segment being appended to. Tracks the per-segment
// dictionaries and the last timestamp so events are stored as delta+varint.
export class SegmentEncoder {
  constructor() {
    this.codes = new Map();
    this.devices = new Map();
    this.lastTs = 0;
    this.count = 0;
  }

  encodeEvent({ seq, ts, code, device }) {
    const parts = [];
    let codeIdx = this.codes.get(code);
    if (codeIdx === undefined) {
      codeIdx = this.codes.size;
      this.codes.set(code, codeIdx);
      parts.push(encodeDictRecord(DICT_CODE, code));
    }
    let deviceIdx = this.devices.get(device);
    if (deviceIdx === undefined) {
      deviceIdx = this.devices.size;
      this.devices.set(device, deviceIdx);
      parts.push(encodeDictRecord(DICT_DEVICE, device));
    }
    const delta = this.count === 0 ? ts : ts - this.lastTs;
    this.lastTs = ts;
    this.count++;
    parts.push(encodeEventRecord(seq, delta, codeIdx, deviceIdx));
    return Buffer.concat(parts);
  }
}

// Reads a segment tolerantly: stops at the first incomplete/corrupt record and
// reports validEnd so recovery can truncate the torn tail.
export function readSegment(path) {
  const buf = fs.readFileSync(path);
  if (buf.length < 6 || !buf.subarray(0, 4).equals(MAGIC)) {
    throw ioError(`corrupt segment header: ${path}`);
  }
  if (buf[4] !== VERSION) throw ioError(`unsupported segment version ${buf[4]}: ${path}`);
  const state = buf[STATE_OFFSET];
  let off = 6;
  let header;
  try {
    const h = uvarintDecode(buf, off);
    off = h.offset;
    header = JSON.parse(buf.subarray(off, off + h.value).toString('utf8'));
    off += h.value;
  } catch {
    throw ioError(`corrupt segment header: ${path}`);
  }

  const codes = [];
  const devices = [];
  const events = [];
  let lastTs = 0;
  let validEnd = off;
  let truncatedBytes = 0;
  let truncateReason = null;

  const bail = (reason, recordStart) => {
    truncatedBytes = buf.length - recordStart;
    truncateReason = reason;
    off = recordStart;
  };

  while (off < buf.length) {
    const recordStart = off;
    let len;
    try {
      const r = uvarintDecode(buf, off);
      len = r.value;
      off = r.offset;
    } catch {
      bail('truncated-length', recordStart);
      break;
    }
    if (off + len + 4 > buf.length) {
      bail('truncated-payload', recordStart);
      break;
    }
    const payload = buf.subarray(off, off + len);
    if (crc32(payload) !== buf.readUInt32LE(off + len)) {
      bail('crc-mismatch', recordStart);
      break;
    }
    off += len + 4;
    try {
      const kind = payload[0];
      if (kind === KIND_DICT) {
        const s = uvarintDecode(payload, 2);
        const str = payload.subarray(s.offset, s.offset + s.value).toString('utf8');
        (payload[1] === DICT_CODE ? codes : devices).push(str);
      } else if (kind === KIND_EVENT) {
        let p = 1;
        const seq = uvarintDecode(payload, p); p = seq.offset;
        const delta = uvarintDecode(payload, p); p = delta.offset;
        const ci = uvarintDecode(payload, p); p = ci.offset;
        const di = uvarintDecode(payload, p); p = di.offset;
        const ts = events.length === 0 ? zigzagDecode(delta.value) : lastTs + zigzagDecode(delta.value);
        lastTs = ts;
        events.push({ seq: seq.value, ts, codeIdx: ci.value, deviceIdx: di.value });
      } else {
        throw new Error(`unknown record kind ${kind}`);
      }
    } catch {
      bail('corrupt-record', recordStart);
      break;
    }
    validEnd = off;
  }

  return { id: header.id, state, codes, devices, events, validEnd, size: buf.length, truncatedBytes, truncateReason };
}
