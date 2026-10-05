'use strict';

const fs = require('node:fs');
const { canonical, sha256 } = require('./biobank');

function makeRecord(result) {
  const body = { step: result.step, events: result.events, hash: result.hash };
  return { ...body, checksum: sha256(canonical(body)) };
}

function verifyRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (!Number.isInteger(rec.step) || !Array.isArray(rec.events) || typeof rec.hash !== 'string') return false;
  const body = { step: rec.step, events: rec.events, hash: rec.hash };
  return rec.checksum === sha256(canonical(body));
}

function appendLog(path, record) {
  const fd = fs.openSync(path, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Reads the append-only log. The first line that fails to parse or fails its
// checksum (e.g. a torn write from a crash) is rejected: the file is truncated
// to the last valid record and the valid prefix is returned.
function loadLog(path) {
  if (!fs.existsSync(path)) return { records: [], corruptedLine: null };
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const records = [];
  let corruptedLine = null;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      if (i === lines.length - 1) break; // trailing newline at EOF
      corruptedLine = i + 1;
      break;
    }
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {
      corruptedLine = i + 1;
      break;
    }
    if (!verifyRecord(rec)) {
      corruptedLine = i + 1;
      break;
    }
    records.push(rec);
    offset += Buffer.byteLength(line, 'utf8') + 1;
  }
  if (corruptedLine !== null) fs.truncateSync(path, offset);
  return { records, corruptedLine };
}

module.exports = { makeRecord, verifyRecord, appendLog, loadLog };
