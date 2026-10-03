'use strict';

const fs = require('fs');
const crypto = require('crypto');

function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Binary Merkle tree over the entry hashes; an odd node is promoted unchanged.
function merkleRoot(hashes) {
  if (!hashes.length) return sha256hex('');
  let level = hashes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256hex(level[i] + level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

const GENESIS = '0'.repeat(64);

// Append-only JSONL log. Every entry is hash-chained to its predecessor and
// carries the Merkle root of all entries so far. The log is the source of
// truth: gateway state is always derivable by replaying it.
class AppendOnlyLog {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.entries = [];
    if (filePath && fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
      let prev = GENESIS;
      for (const line of lines) {
        const entry = JSON.parse(line);
        const { hash, root, ...body } = entry;
        if (sha256hex(prev + JSON.stringify(body)) !== hash) {
          const err = new Error('append-only log integrity check failed');
          err.code = 'CORRUPT_LOG';
          throw err;
        }
        this.entries.push(entry);
        prev = hash;
      }
      if (this.entries.length && this.root() !== this.entries[this.entries.length - 1].root) {
        const err = new Error('append-only log merkle root mismatch');
        err.code = 'CORRUPT_LOG';
        throw err;
      }
    }
  }

  append(fields) {
    const prev = this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS;
    const hash = sha256hex(prev + JSON.stringify(fields));
    const entry = { ...fields, hash };
    entry.root = merkleRoot(this.entries.map((e) => e.hash).concat(hash));
    this.entries.push(entry);
    if (this.filePath) fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    return entry;
  }

  root() {
    return merkleRoot(this.entries.map((e) => e.hash));
  }
}

module.exports = { AppendOnlyLog, merkleRoot, sha256hex };
