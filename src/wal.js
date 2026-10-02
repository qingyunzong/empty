import fs from 'node:fs';
import { crc32 } from './crc32.js';

export const HEADER_SIZE = 8; // u32 payload length + u32 crc32(payload)

export class WalError extends Error {
  constructor(code, message, offset) {
    super(message);
    this.code = code;
    this.offset = offset;
  }
}

export function encodeRecord(record) {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  const frame = Buffer.alloc(HEADER_SIZE + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  frame.writeUInt32LE(crc32(payload), 4);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

// Scan a buffer of framed records. Returns { records, endOffset, truncated }.
// A partial tail (crash mid-write) is reported via `truncated` and `endOffset`
// points at the first byte of the incomplete record.
// A complete frame with a bad checksum throws WalError('CHECKSUM_MISMATCH')
// carrying the byte offset of the offending record.
export function scanBuffer(buf) {
  const records = [];
  let pos = 0;
  while (pos + HEADER_SIZE <= buf.length) {
    const len = buf.readUInt32LE(pos);
    const crc = buf.readUInt32LE(pos + 4);
    if (pos + HEADER_SIZE + len > buf.length) {
      return { records, endOffset: pos, truncated: true };
    }
    const payload = buf.subarray(pos + HEADER_SIZE, pos + HEADER_SIZE + len);
    if (crc32(payload) !== crc) {
      throw new WalError(
        'CHECKSUM_MISMATCH',
        `checksum mismatch at offset ${pos}`,
        pos,
      );
    }
    records.push(JSON.parse(payload.toString('utf8')));
    pos += HEADER_SIZE + len;
  }
  return { records, endOffset: pos, truncated: pos < buf.length };
}

// Recover the WAL at `path`: validate every frame, and if the tail is a
// partial record (torn write from a crash), truncate the file to the last
// valid offset so later appends stay well-formed. Checksum failures on
// complete frames are fatal and reported with their offset.
export function recoverWal(path) {
  if (!fs.existsSync(path)) {
    return { records: [], endOffset: 0, truncated: false };
  }
  const buf = fs.readFileSync(path);
  const { records, endOffset, truncated } = scanBuffer(buf);
  if (truncated) {
    fs.truncateSync(path, endOffset);
  }
  return { records, endOffset, truncated };
}

export class WalWriter {
  constructor(path) {
    this.path = path;
    this.fd = fs.openSync(path, 'a');
  }

  // Append one logical record. Hooks simulate crash points:
  // onAfterWrite fires after the file write, before fsync;
  // onAfterFsync fires after the flush to disk.
  append(record, hooks = {}) {
    const frame = encodeRecord(record);
    fs.writeSync(this.fd, frame);
    if (hooks.onAfterWrite) hooks.onAfterWrite();
    fs.fsyncSync(this.fd);
    if (hooks.onAfterFsync) hooks.onAfterFsync();
    return frame.length;
  }

  close() {
    fs.closeSync(this.fd);
  }
}
