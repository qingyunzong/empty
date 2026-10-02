import fs from 'node:fs';
import { crc32 } from './crc32.js';

export const FRAME_TXN = 1;
export const FRAME_COMMIT = 2;

const HEADER_LEN = 9; // u32 payload length + u32 seq + u8 type
const CRC_LEN = 4;

export function encodeFrame(seq, type, payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt32LE(seq, 4);
  header.writeUInt8(type, 8);
  const body = Buffer.concat([header, payload]);
  const crcBuf = Buffer.alloc(CRC_LEN);
  crcBuf.writeUInt32LE(crc32(body), 0);
  return Buffer.concat([body, crcBuf]);
}

// Scans a buffer, returning all valid frames up to the first corruption.
// Any CRC mismatch, truncated frame or trailing garbage stops the scan;
// everything from that offset on is discarded.
export function scanBuffer(buf) {
  const frames = [];
  let offset = 0;
  let error = null;
  while (offset + HEADER_LEN + CRC_LEN <= buf.length) {
    const length = buf.readUInt32LE(offset);
    const seq = buf.readUInt32LE(offset + 4);
    const type = buf.readUInt8(offset + 8);
    const end = offset + HEADER_LEN + length + CRC_LEN;
    if (end > buf.length) {
      error = { code: 'E_TRUNCATED_FRAME', offset };
      break;
    }
    const body = buf.subarray(offset, offset + HEADER_LEN + length);
    const expected = buf.readUInt32LE(offset + HEADER_LEN + length);
    if (crc32(body) !== expected) {
      error = { code: 'E_CRC_MISMATCH', offset };
      break;
    }
    let payload;
    try {
      payload = JSON.parse(buf.subarray(offset + HEADER_LEN, offset + HEADER_LEN + length).toString('utf8'));
    } catch {
      error = { code: 'E_BAD_PAYLOAD', offset };
      break;
    }
    frames.push({ seq, type, payload, offset });
    offset = end;
  }
  if (!error && offset !== buf.length) {
    error = { code: 'E_TRUNCATED_FRAME', offset };
  }
  return { frames, validBytes: offset, error };
}

export class Wal {
  constructor(path) {
    this.path = path;
    this.fd = null;
    this.nextSeq = 1;
  }

  open() {
    let existing = Buffer.alloc(0);
    if (fs.existsSync(this.path)) {
      existing = fs.readFileSync(this.path);
    }
    const { frames } = scanBuffer(existing);
    for (const frame of frames) {
      if (frame.seq >= this.nextSeq) this.nextSeq = frame.seq + 1;
    }
    this.fd = fs.openSync(this.path, 'a');
    return frames;
  }

  append(type, payloadObj) {
    const seq = this.nextSeq++;
    fs.writeSync(this.fd, encodeFrame(seq, type, payloadObj));
    return seq;
  }

  fsync() {
    fs.fsyncSync(this.fd);
  }

  close() {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}
