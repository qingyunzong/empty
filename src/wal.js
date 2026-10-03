'use strict';

const fs = require('node:fs');
const { crc32 } = require('./crc32');

const HEADER_SIZE = 12; // length(4) + seq(4) + crc32(4)

function encodeFrame(seq, record) {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt32LE(seq >>> 0, 4);
  const crc = crc32(Buffer.concat([header.subarray(0, 8), payload]));
  header.writeUInt32LE(crc, 8);
  return Buffer.concat([header, payload]);
}

// Scan a buffer, returning all valid frames and the offset just past the last
// valid frame. Stops at the first CRC mismatch, truncated frame, or bad JSON.
function scanFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + HEADER_SIZE <= buf.length) {
    const length = buf.readUInt32LE(offset);
    const seq = buf.readUInt32LE(offset + 4);
    const crc = buf.readUInt32LE(offset + 8);
    const end = offset + HEADER_SIZE + length;
    if (end > buf.length) break; // truncated frame
    const payload = buf.subarray(offset + HEADER_SIZE, end);
    const actual = crc32(Buffer.concat([buf.subarray(offset, offset + 8), payload]));
    if (actual !== crc) break; // CRC mismatch
    let record;
    try {
      record = JSON.parse(payload.toString('utf8'));
    } catch {
      break;
    }
    frames.push({ seq, record, offset, end });
    offset = end;
  }
  return { frames, validEnd: offset };
}

class Wal {
  constructor(path) {
    this.path = path;
    this.lastSeq = 0;
    this.frames = [];
  }

  // Scan the WAL file, discard any corrupt/truncated tail, and truncate the
  // file back to the last valid frame so future appends stay clean.
  recover() {
    let buf = Buffer.alloc(0);
    try {
      buf = fs.readFileSync(this.path);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const { frames, validEnd } = scanFrames(buf);
    if (validEnd < buf.length) {
      const fd = fs.openSync(this.path, 'r+');
      try {
        fs.ftruncateSync(fd, validEnd);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    this.frames = frames;
    this.lastSeq = frames.length > 0 ? frames[frames.length - 1].seq : 0;
    return { frames, discardedBytes: buf.length - validEnd };
  }

  append(record) {
    const seq = this.lastSeq + 1;
    const frame = encodeFrame(seq, record);
    fs.appendFileSync(this.path, frame);
    this.lastSeq = seq;
    this.frames.push({ seq, record, offset: -1, end: -1 });
    return seq;
  }

  fsync() {
    const fd = fs.openSync(this.path, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

module.exports = { Wal, encodeFrame, scanFrames, HEADER_SIZE };
