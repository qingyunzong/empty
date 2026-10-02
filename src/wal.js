'use strict';

// ---------------------------------------------------------------------------
// Write-ahead log with per-record CRC32 checksums and crash recovery.
//
// Record kinds:
//   {"kind":"config", ...}            first record, service configuration
//   {"kind":"frame",  "seq":N, ...}   a decided frame (idempotent on replay)
//   {"kind":"tick",   "to":T}         a virtual-clock advance
//
// Recovery: read until the first corrupt/torn tail record, truncate it away,
// then replay. Frames carry their protocol seq, so a crash after logging but
// before responding never causes a double application.
// ---------------------------------------------------------------------------

const fs = require('node:fs');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class Wal {
  constructor(path) {
    this.path = path;
    this.fd = null;
    this.appliedFrames = 0;
  }

  open() {
    this.fd = fs.openSync(this.path, 'a+');
    return this.recover();
  }

  // Returns { records, truncatedBytes }.
  recover() {
    const buf = fs.readFileSync(this.path);
    const records = [];
    let offset = 0;
    let corruptAt = -1;
    while (offset + 4 <= buf.length) {
      const len = buf.readUInt32LE(offset);
      const end = offset + 4 + len + 4;
      if (len <= 0 || end > buf.length) { corruptAt = offset; break; }
      const payload = buf.subarray(offset + 4, offset + 4 + len);
      const crc = buf.readUInt32LE(offset + 4 + len);
      if (crc32(payload) !== crc) { corruptAt = offset; break; }
      try {
        records.push(JSON.parse(payload.toString('utf8')));
      } catch {
        corruptAt = offset;
        break;
      }
      offset = end;
    }
    if (offset < buf.length && corruptAt === -1) corruptAt = offset; // torn tail
    let truncatedBytes = 0;
    if (corruptAt >= 0 && corruptAt < buf.length) {
      truncatedBytes = buf.length - corruptAt;
      fs.truncateSync(this.path, corruptAt);
    }
    return { records, truncatedBytes };
  }

  append(record) {
    const payload = Buffer.from(JSON.stringify(record), 'utf8');
    const frame = Buffer.alloc(4 + payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    frame.writeUInt32LE(crc32(payload), 4 + payload.length);
    fs.writeSync(this.fd, frame);
    fs.fsyncSync(this.fd);
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

module.exports = { Wal, crc32 };
