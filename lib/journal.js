'use strict';

const fs = require('node:fs');

// Reads a JSONL journal. Tolerates a torn tail record (crash mid-append):
// parsing stops at the first unparseable non-empty line and reports it.
function readJournal(journalPath) {
  if (!fs.existsSync(journalPath)) {
    return { records: [], torn: null, validBytes: 0 };
  }
  const text = fs.readFileSync(journalPath, 'utf8');
  const records = [];
  let torn = null;
  let pos = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    const lineBytes = Buffer.byteLength(line) + (isLast ? 0 : 1);
    if (line.trim() === '') {
      pos += lineBytes;
      continue;
    }
    try {
      records.push(JSON.parse(line));
      pos += lineBytes;
    } catch {
      torn = { offset: pos, raw: line };
      break;
    }
  }
  return { records, torn, validBytes: pos };
}

function appendRecord(journalPath, record) {
  fs.appendFileSync(journalPath, JSON.stringify(record) + '\n');
}

// Raw append without newline; used to simulate a torn checkpoint write.
function appendRaw(journalPath, raw) {
  fs.appendFileSync(journalPath, raw);
}

function truncateJournal(journalPath, bytes) {
  fs.truncateSync(journalPath, bytes);
}

module.exports = { readJournal, appendRecord, appendRaw, truncateJournal };
