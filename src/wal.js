'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Append-only write-ahead log.
// Frame layout: [u32le payloadLength][payload JSON bytes][u32le crc32(payload)].
// A torn or corrupt tail (crash mid-write) is truncated on open.

class Wal {
  constructor(file) {
    this.file = file;
    this.fd = null;
  }

  open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this._truncateTornTail();
    this.fd = fs.openSync(this.file, 'a');
  }

  _truncateTornTail() {
    if (!fs.existsSync(this.file)) return;
    const buf = fs.readFileSync(this.file);
    const good = scanFrames(buf).endOffset;
    if (good < buf.length) {
      fs.truncateSync(this.file, good);
    }
  }

  append(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const frame = Buffer.alloc(4 + payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    frame.writeUInt32LE(zlib.crc32(payload), 4 + payload.length);
    fs.writeSync(this.fd, frame);
    fs.fsyncSync(this.fd);
  }

  readAll() {
    if (!fs.existsSync(this.file)) return [];
    const buf = fs.readFileSync(this.file);
    const { entries } = scanFrames(buf);
    return entries;
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

function scanFrames(buf) {
  const entries = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const end = off + 4 + len + 4;
    if (end > buf.length) break; // incomplete tail
    const payload = buf.subarray(off + 4, off + 4 + len);
    const crc = buf.readUInt32LE(off + 4 + len);
    if (zlib.crc32(payload) !== crc) break; // corrupt tail
    entries.push(JSON.parse(payload.toString('utf8')));
    off = end;
  }
  return { entries, endOffset: off };
}

module.exports = { Wal };
