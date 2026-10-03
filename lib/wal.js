'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Append-only JSONL write-ahead log. Records: match / cancel / unfreeze / unpair.
class Wal {
  constructor(filePath) {
    this.path = filePath;
    this.records = [];
    if (fs.existsSync(filePath)) {
      for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed) this.records.push(JSON.parse(trimmed));
      }
    }
  }

  append(record) {
    const full = { seq: this.records.length + 1, ...record };
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.appendFileSync(this.path, JSON.stringify(full) + '\n');
    this.records.push(full);
    return full;
  }
}

module.exports = { Wal };
