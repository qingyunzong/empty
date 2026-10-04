'use strict';
const fs = require('node:fs');
const { canonical, sha256hex } = require('./util');

// Append-only write-ahead log. Each record carries a hash link to its
// predecessor so a per-transaction verifiable chain can be extracted later.
class Wal {
  constructor(file, node) {
    this.file = file;
    this.node = node;
    this.records = [];
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line) this.records.push(JSON.parse(line));
      }
    }
    this.head = this.records.length ? this.records[this.records.length - 1].hash : 'GENESIS';
  }
  append(rec, ts) {
    const record = { node: this.node, ts, ...rec, prev: this.head };
    record.hash = sha256hex(canonical(record));
    fs.appendFileSync(this.file, JSON.stringify(record) + '\n');
    this.records.push(record);
    this.head = record.hash;
    return record;
  }
}

module.exports = Wal;
