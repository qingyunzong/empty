'use strict';

// Append-only measure journal with crash-safe recovery.
// Frame layout: 'M' 'J' | uint32LE payload length | payload (JSON) | uint32LE crc32(len|payload)
// Fault points handled: append (torn tail), fsync (durability before ack),
// rename (atomic state snapshots via atomicWriteFile).

const fs = require('node:fs');
const path = require('node:path');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAGIC0 = 0x4d; // 'M'
const MAGIC1 = 0x4a; // 'J'
const HEADER_LEN = 6; // magic(2) + length(4)
const CRC_LEN = 4;

function encodeFrame(record) {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(payload.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(Buffer.concat([len, payload])), 0);
  return Buffer.concat([Buffer.from([MAGIC0, MAGIC1]), len, payload, crc]);
}

class Journal {
  constructor(filePath) {
    this.path = filePath;
  }

  // Append one framed record and fsync before returning.
  append(record) {
    const frame = encodeFrame(record);
    const fd = fs.openSync(this.path, 'a');
    try {
      fs.writeSync(fd, frame, 0, frame.length, null);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return record;
  }
}

// Scan the journal, keep only complete valid frames, truncate any torn tail
// (crash between append and fsync) so a half-written measure never surfaces.
function recoverJournal(filePath) {
  const empty = { records: [], recovered: false, truncatedBytes: 0 };
  if (!fs.existsSync(filePath)) return empty;
  const buf = fs.readFileSync(filePath);
  let offset = 0;
  const records = [];
  while (offset + HEADER_LEN + CRC_LEN <= buf.length) {
    if (buf[offset] !== MAGIC0 || buf[offset + 1] !== MAGIC1) break;
    const len = buf.readUInt32LE(offset + 2);
    const end = offset + HEADER_LEN + len + CRC_LEN;
    if (end > buf.length) break; // torn tail: incomplete frame
    const lenBuf = buf.subarray(offset + 2, offset + HEADER_LEN);
    const payload = buf.subarray(offset + HEADER_LEN, offset + HEADER_LEN + len);
    const crc = buf.readUInt32LE(offset + HEADER_LEN + len);
    if (crc32(Buffer.concat([lenBuf, payload])) !== crc) break; // corrupt frame
    records.push(JSON.parse(payload.toString('utf8')));
    offset = end;
  }
  const truncatedBytes = buf.length - offset;
  if (truncatedBytes > 0) {
    const fd = fs.openSync(filePath, 'r+');
    try {
      fs.ftruncateSync(fd, offset);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { records, recovered: true, truncatedBytes };
  }
  return { records, recovered: false, truncatedBytes: 0 };
}

// Atomic file replace: write tmp + fsync + rename + fsync(dir).
function atomicWriteFile(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  const dfd = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(dfd);
  } finally {
    fs.closeSync(dfd);
  }
}

module.exports = { Journal, recoverJournal, atomicWriteFile, encodeFrame, crc32 };
