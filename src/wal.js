'use strict';

const fs = require('node:fs');
const { crc32 } = require('./crc32');

const HEADER_SIZE = 8; // 4B payload length + 4B crc32 of payload

function encodeRecord(record) {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  const header = Buffer.allocUnsafe(HEADER_SIZE);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt32LE(crc32(payload), 4);
  return Buffer.concat([header, payload]);
}

class WalWriter {
  constructor(path) {
    this.path = path;
    this.fd = null;
  }

  open() {
    this.fd = fs.openSync(this.path, 'a');
  }

  append(records) {
    const buf = Buffer.concat(records.map(encodeRecord));
    let off = 0;
    while (off < buf.length) {
      off += fs.writeSync(this.fd, buf, off, buf.length - off);
    }
  }

  fsync() {
    fs.fsyncSync(this.fd);
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

// Parses the WAL. Returns all valid records plus the offset at which parsing
// stopped. Any trailing garbage / partial record (crash mid-append) shows up
// as stopOffset < file size and is safe to truncate.
function replayWal(path) {
  let data;
  try {
    data = fs.readFileSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return { records: [], stopOffset: 0, fileSize: 0 };
    throw err;
  }
  const records = [];
  let offset = 0;
  while (offset + HEADER_SIZE <= data.length) {
    const len = data.readUInt32LE(offset);
    const sum = data.readUInt32LE(offset + 4);
    if (len === 0 || offset + HEADER_SIZE + len > data.length) break;
    const payload = data.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + len);
    if (crc32(payload) !== sum) break;
    let record;
    try {
      record = JSON.parse(payload.toString('utf8'));
    } catch {
      break;
    }
    records.push(record);
    offset += HEADER_SIZE + len;
  }
  return { records, stopOffset: offset, fileSize: data.length };
}

module.exports = { WalWriter, replayWal, encodeRecord };
