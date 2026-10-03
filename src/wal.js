import fs from 'node:fs';
import { RevError, E } from './errors.js';

export class Wal {
  constructor(path) {
    this.path = path;
    this.seq = 0;
  }

  append(record) {
    record.seq = ++this.seq;
    try {
      fs.appendFileSync(this.path, JSON.stringify(record) + '\n');
    } catch (err) {
      throw new RevError(E.IO, `cannot append to wal '${this.path}': ${err.message}`);
    }
    return record;
  }

  static readAll(path) {
    let raw;
    try {
      raw = fs.readFileSync(path, 'utf8');
    } catch (err) {
      throw new RevError(E.IO, `cannot read wal '${path}': ${err.message}`);
    }
    const records = [];
    const lines = raw.split('\n');
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        throw new RevError(E.IO, `corrupt wal record at line ${idx + 1}`);
      }
    }
    return records;
  }

  static inspect(path) {
    if (!fs.existsSync(path)) return { exists: false };
    const records = Wal.readAll(path);
    return {
      exists: true,
      records,
      header: records.find((r) => r.type === 'header') ?? null,
      committed: records.some((r) => r.type === 'commit' && r.final === true),
    };
  }
}
