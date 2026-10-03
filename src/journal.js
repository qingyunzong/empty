import fs from 'node:fs';

// Append-only journal with two fault points:
//  1. crash after PLAN but before COMMIT  -> the plan is discarded on recovery;
//  2. crash after COMMIT                  -> replay must be idempotent
//     (committed plans are applied at most once, deduplicated by id).
export class Journal {
  constructor(path) {
    this.path = path;
  }

  append(record) {
    const fd = fs.openSync(this.path, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  plan(id, payload) {
    this.append({ type: 'plan', id, payload });
  }

  commit(id) {
    this.append({ type: 'commit', id });
  }

  static read(path) {
    if (!fs.existsSync(path)) return [];
    return fs
      .readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }

  // Committed plans in journal order, deduplicated by id (idempotent replay).
  static committedPlans(path) {
    const records = Journal.read(path);
    const committed = new Set();
    for (const rec of records) if (rec.type === 'commit') committed.add(rec.id);
    const out = [];
    const seen = new Set();
    for (const rec of records) {
      if (rec.type === 'plan' && committed.has(rec.id) && !seen.has(rec.id)) {
        seen.add(rec.id);
        out.push({ id: rec.id, payload: rec.payload });
      }
    }
    return out;
  }
}
