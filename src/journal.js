'use strict';
const fs = require('node:fs');
const { canonical, sha256 } = require('./util');

function crcOf(record) {
  return sha256(canonical({ seq: record.seq, event: record.event, hash: record.hash })).slice(0, 16);
}

function append(path, record) {
  const line = JSON.stringify({ seq: record.seq, event: record.event, hash: record.hash, crc: crcOf(record) });
  fs.appendFileSync(path, line + '\n');
}

function load(path) {
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const records = [];
  let torn = false;
  let tornLine = -1;
  let goodBytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '' && i === lines.length - 1) break; // trailing newline after last good record
    let rec = null;
    let bad = false;
    try {
      rec = JSON.parse(line);
    } catch {
      bad = true;
    }
    if (!bad && (!rec || rec.seq !== records.length || crcOf(rec) !== rec.crc)) bad = true;
    if (bad) {
      torn = true;
      tornLine = i + 1;
      break;
    }
    records.push(rec);
    goodBytes += Buffer.byteLength(line) + 1;
  }
  if (torn) {
    const fd = fs.openSync(path, 'r+');
    try {
      fs.ftruncateSync(fd, goodBytes);
    } finally {
      fs.closeSync(fd);
    }
  }
  return { records, torn, tornLine };
}

module.exports = { append, load, crcOf };
