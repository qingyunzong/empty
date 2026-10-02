'use strict';

const crypto = require('crypto');

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256hex('');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256hex(a + b));
    }
    level = next;
  }
  return level[0];
}

// Append-only decision log. Records are plain JSON objects; `append` stamps a
// monotonically increasing index. The Merkle root commits to the full history.
class AppendOnlyLog {
  constructor(records = []) {
    this.records = records.slice();
  }

  append(record) {
    record.index = this.records.length;
    this.records.push(record);
    return record;
  }

  get length() {
    return this.records.length;
  }

  leaf(record) {
    return sha256hex(stableStringify(record));
  }

  root() {
    return merkleRoot(this.records.map((r) => this.leaf(r)));
  }

  toJSONL() {
    return this.records.map((r) => JSON.stringify(r)).join('\n') + (this.records.length ? '\n' : '');
  }

  static fromJSONL(text) {
    const records = text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    return new AppendOnlyLog(records);
  }
}

module.exports = { AppendOnlyLog, sha256hex, stableStringify, merkleRoot };
