'use strict';

const fs = require('node:fs');

// Append-only write-ahead log. Each record is one JSON line, fsync'd before
// the caller is allowed to reply, so a crash after the write is recoverable.
class Wal {
  constructor(path) {
    this.path = path;
    this.fd = null;
  }

  records() {
    if (!fs.existsSync(this.path)) return [];
    return fs
      .readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  }

  append(record) {
    if (this.fd === null) this.fd = fs.openSync(this.path, 'a');
    fs.writeSync(this.fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(this.fd);
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

module.exports = { Wal };
