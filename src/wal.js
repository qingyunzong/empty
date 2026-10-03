'use strict';

const fs = require('node:fs');
const { crc32 } = require('./crc32');

// WAL record: one line per record, "<crc32hex> <json>\n".
// crc32 is computed over the raw JSON bytes. Torn/corrupt tail lines
// are detected via CRC mismatch and truncated on recovery.

function encodeRecord(rec) {
  const json = Buffer.from(JSON.stringify(rec), 'utf8');
  const crc = crc32(json).toString(16).padStart(8, '0');
  return Buffer.concat([Buffer.from(crc + ' ', 'utf8'), json, Buffer.from('\n')]);
}

function decodeLine(line) {
  const sp = line.indexOf(0x20); // space
  if (sp !== 8) return null;
  const crcHex = line.subarray(0, 8).toString('utf8');
  const json = line.subarray(9);
  const expected = Number.parseInt(crcHex, 16);
  if (!Number.isInteger(expected) || crc32(json) !== expected >>> 0) return null;
  try {
    return JSON.parse(json.toString('utf8'));
  } catch {
    return null;
  }
}

class WalWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'a');
    this.offset = fs.fstatSync(this.fd).size;
  }

  append(records) {
    const buf = Buffer.concat(records.map(encodeRecord));
    fs.writeSync(this.fd, buf, 0, buf.length, this.offset);
    this.offset += buf.length;
  }

  fsync() {
    fs.fsyncSync(this.fd);
  }

  close() {
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
  }
}

// Replays the WAL from `fromOffset`. Returns { transactions, endOffset } where
// transactions is a list of committed op-lists. Torn or corrupt tail data is
// truncated so future appends start at a clean boundary.
function replayWal(filePath, fromOffset = 0) {
  const transactions = [];
  if (!fs.existsSync(filePath)) {
    return { transactions, endOffset: 0 };
  }
  const buf = fs.readFileSync(filePath);
  let pos = fromOffset;
  let lastGood = fromOffset;
  let pending = null;

  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break; // incomplete tail line
    const rec = decodeLine(buf.subarray(pos, nl));
    if (rec === null) break; // corrupt record: stop, truncate below
    pos = nl + 1;
    lastGood = pos;
    if (rec.t === 'begin') {
      pending = [];
    } else if (rec.t === 'commit') {
      if (pending !== null) {
        transactions.push(pending);
        pending = null;
      }
    } else if ((rec.t === 'put' || rec.t === 'del') && pending !== null) {
      pending.push(rec);
    }
    // ops outside a begin/commit scope are ignored
  }

  if (lastGood < buf.length) {
    const fd = fs.openSync(filePath, 'r+');
    try {
      fs.ftruncateSync(fd, lastGood);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  return { transactions, endOffset: lastGood };
}

module.exports = { WalWriter, replayWal, encodeRecord };
