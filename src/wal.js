import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './crc32.js';

// Frame layout (little-endian):
//   [0..3]  payload length (uint32)
//   [4..7]  CRC32 of payload (uint32)
//   [8..11] sequence number (uint32)
//   [12]    commit flag (0x00 = uncommitted, 0x01 = committed)
//   [13..]  payload bytes
export const HEADER_SIZE = 13;
export const COMMIT_OFFSET = 12;
export const MAX_PAYLOAD = 16 * 1024 * 1024;

export const FAULT_POINTS = Object.freeze(['after_data', 'after_sync', 'after_commit']);

function readFully(fd, buf, offset, position) {
  let read = 0;
  while (read < buf.length) {
    const n = fs.readSync(fd, buf, read + offset, buf.length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return read;
}

export class Wal {
  constructor(file) {
    this.file = file;
    this.fd = null;
    this.size = 0;
    this.nextSeq = 0;
  }

  open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // O_RDWR (not O_APPEND): all writes use explicit positions, and the
    // commit-flag update must overwrite in place rather than append.
    this.fd = fs.openSync(this.file, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644);
    this.size = fs.fstatSync(this.fd).size;
    return this;
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  // Scans the file and returns the longest prefix of frames that are
  // complete, CRC-valid and carry a set commit flag. Anything past the
  // first incomplete/corrupt/uncommitted frame is considered garbage.
  scan() {
    const size = fs.fstatSync(this.fd).size;
    const records = [];
    let pos = 0;
    while (pos + HEADER_SIZE <= size) {
      const header = Buffer.alloc(HEADER_SIZE);
      if (readFully(this.fd, header, 0, pos) < HEADER_SIZE) break;
      const len = header.readUInt32LE(0);
      const crc = header.readUInt32LE(4);
      const seq = header.readUInt32LE(8);
      const commit = header.readUInt8(COMMIT_OFFSET);
      if (len === 0 || len > MAX_PAYLOAD) break;
      if (pos + HEADER_SIZE + len > size) break;
      const payload = Buffer.alloc(len);
      if (readFully(this.fd, payload, 0, pos + HEADER_SIZE) < len) break;
      if (crc32(payload) !== crc) break;
      if (commit !== 1) break;
      records.push({ offset: pos, seq, payload });
      pos += HEADER_SIZE + len;
    }
    return { records, validBytes: pos, fileBytes: size };
  }

  // Truncates the file to the longest valid committed prefix and returns
  // the surviving records plus the number of discarded tail bytes.
  recover() {
    const { records, validBytes, fileBytes } = this.scan();
    const truncatedBytes = fileBytes - validBytes;
    if (truncatedBytes > 0) {
      fs.ftruncateSync(this.fd, validBytes);
      fs.fsyncSync(this.fd);
    }
    this.size = validBytes;
    this.nextSeq = records.length === 0 ? 0 : records[records.length - 1].seq + 1;
    return { records, truncatedBytes };
  }

  // Two-phase commit append:
  //   1. write frame with commit=0        -> fault point: after_data
  //   2. fsync data                       -> fault point: after_sync
  //   3. write commit flag + fsync        -> fault point: after_commit
  // opts.fault names a fault point; opts.onFault(point) is invoked there
  // (default behaviour is process.exit(101) to simulate a crash).
  append(payload, opts = {}) {
    const seq = this.nextSeq;
    const offset = this.size;
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(payload.length, 0);
    header.writeUInt32LE(crc32(payload), 4);
    header.writeUInt32LE(seq, 8);
    header.writeUInt8(0, COMMIT_OFFSET);
    fs.writeSync(this.fd, header, 0, HEADER_SIZE, offset);
    fs.writeSync(this.fd, payload, 0, payload.length, offset + HEADER_SIZE);
    this.#hitFault('after_data', opts);
    fs.fsyncSync(this.fd);
    this.#hitFault('after_sync', opts);
    const flag = Buffer.from([1]);
    fs.writeSync(this.fd, flag, 0, 1, offset + COMMIT_OFFSET);
    fs.fsyncSync(this.fd);
    this.#hitFault('after_commit', opts);
    this.size = offset + HEADER_SIZE + payload.length;
    this.nextSeq = seq + 1;
    return { seq, offset };
  }

  #hitFault(point, opts) {
    if (opts.fault === point) {
      if (typeof opts.onFault === 'function') {
        opts.onFault(point);
      } else {
        process.exit(101);
      }
    }
  }
}
