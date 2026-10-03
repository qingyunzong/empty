// Append-only JSONL log. Every record carries a monotonically increasing seq
// and a non-decreasing ts. Corruption is reported, never silently repaired:
//   ERR_GAP   - a seq hole (record lost / torn write)
//   ERR_CLOCK - ts went backwards in append order (clock inversion)
import fs from 'node:fs';

export class LogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LogError';
    this.code = code;
  }
}

export class AppendOnlyLog {
  constructor(path) {
    this.path = path;
    this.seq = 0;
    this.lastTs = -Infinity;
    if (fs.existsSync(path)) {
      const records = AppendOnlyLog.readAll(path);
      if (records.length > 0) {
        this.seq = records[records.length - 1].seq + 1;
        this.lastTs = records[records.length - 1].ts;
      }
    }
  }

  // record: { type: 'op'|'event'|'inject', ... }. ts defaults to Date.now().
  append(record, ts) {
    const rec = { ...record, seq: this.seq, ts: ts ?? record.ts ?? Date.now() };
    if (rec.ts < this.lastTs) {
      throw new LogError('ERR_CLOCK', `clock inversion: ts ${rec.ts} < previous ${this.lastTs}`);
    }
    fs.appendFileSync(this.path, JSON.stringify(rec) + '\n');
    this.seq += 1;
    this.lastTs = rec.ts;
    return rec;
  }

  readAll() {
    return AppendOnlyLog.readAll(this.path);
  }

  static readAll(path) {
    const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const records = [];
    let prevTs = -Infinity;
    for (let i = 0; i < lines.length; i++) {
      const rec = JSON.parse(lines[i]);
      if (rec.seq !== i) {
        throw new LogError('ERR_GAP', `log gap: expected seq ${i}, found ${rec.seq}`);
      }
      if (rec.ts < prevTs) {
        throw new LogError('ERR_CLOCK', `clock inversion at seq ${rec.seq}: ts ${rec.ts} < ${prevTs}`);
      }
      prevTs = rec.ts;
      records.push(rec);
    }
    return records;
  }
}
