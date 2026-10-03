'use strict';

const fs = require('node:fs');
const { crc32 } = require('./crc32');

const HEADER_LEN = 4; // u32 payload length
const CRC_LEN = 4;

function encodeRecord(record) {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  const frame = Buffer.allocUnsafe(HEADER_LEN + payload.length + CRC_LEN);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, HEADER_LEN);
  frame.writeUInt32LE(crc32(payload), HEADER_LEN + payload.length);
  return frame;
}

class WalWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'a');
    this.offset = fs.fstatSync(this.fd).size;
  }

  append(record) {
    const frame = encodeRecord(record);
    fs.writeSync(this.fd, frame, 0, frame.length, this.offset);
    const recordOffset = this.offset;
    this.offset += frame.length;
    return recordOffset;
  }

  fsync() {
    fs.fsyncSync(this.fd);
  }

  truncate(size) {
    fs.ftruncateSync(this.fd, size);
    this.offset = size;
  }

  close() {
    fs.closeSync(this.fd);
  }
}

function recover(filePath) {
  const records = [];
  if (!fs.existsSync(filePath)) {
    return { records, validEnd: 0 };
  }
  const buf = fs.readFileSync(filePath);
  let offset = 0;
  while (true) {
    if (buf.length - offset < HEADER_LEN) break;
    const payloadLen = buf.readUInt32LE(offset);
    const recordEnd = offset + HEADER_LEN + payloadLen + CRC_LEN;
    if (payloadLen === 0 || recordEnd > buf.length) break;
    const payload = buf.subarray(offset + HEADER_LEN, offset + HEADER_LEN + payloadLen);
    const expectedCrc = buf.readUInt32LE(offset + HEADER_LEN + payloadLen);
    if (crc32(payload) !== expectedCrc) break;
    let record;
    try {
      record = JSON.parse(payload.toString('utf8'));
    } catch {
      break;
    }
    records.push(record);
    offset = recordEnd;
  }
  return { records, validEnd: offset };
}

module.exports = { WalWriter, recover, encodeRecord };
