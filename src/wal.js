'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { DbError } = require('./errors');

function checksum(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

// Append one record as a single JSON line and fsync. The file is opened and
// closed per append so no file descriptor is held between writes.
function appendRecord(walPath, record) {
  const line = JSON.stringify({ ...record, cksum: checksum(record) }) + '\n';
  const fd = fs.openSync(walPath, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Read all valid records. A torn tail (partial last line from a crashed write)
// is truncated and ignored. Any other malformed content is corruption.
function readWal(walPath) {
  if (!fs.existsSync(walPath)) return [];
  const text = fs.readFileSync(walPath, 'utf8');
  const lines = text.split('\n');
  const records = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      if (i !== lines.length - 1) {
        throw new DbError('E_CORRUPT', `wal: empty line at record ${i}`);
      }
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (i === lines.length - 1) {
        fs.truncateSync(walPath, offset);
        break;
      }
      throw new DbError('E_CORRUPT', `wal: unparseable record at line ${i}`);
    }
    const { cksum, ...payload } = parsed;
    if (typeof cksum !== 'string' || cksum !== checksum(payload)) {
      throw new DbError('E_CORRUPT', `wal: checksum mismatch at line ${i}`);
    }
    records.push(payload);
    offset += Buffer.byteLength(line) + 1;
  }
  return records;
}

module.exports = { appendRecord, readWal };
