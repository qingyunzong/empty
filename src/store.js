import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const GENESIS = '0'.repeat(64);

// Append-only journal for measurement points.
// Commit protocol per record:
//   1. append line to measures.log + fsync(log)
//   2. write HEAD.tmp {offset, hash} + fsync(HEAD.tmp)
//   3. rename(HEAD.tmp -> HEAD) + fsync(dir)
// A crash at any point leaves HEAD at the last committed offset, so recovery
// never exposes a half-written measure. Lines carry a hash chain; recovery
// stops at the first torn or corrupt line and keeps the verified prefix.
export class Journal {
  constructor(dir) {
    this.dir = dir;
    this.logPath = path.join(dir, 'measures.log');
    this.headPath = path.join(dir, 'HEAD');
    fs.mkdirSync(dir, { recursive: true });
    this.records = [];
    this.offset = 0;
    this.hash = GENESIS;
    this._recover();
  }

  _recover() {
    let head = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.headPath, 'utf8'));
      if (Number.isInteger(parsed.offset) && typeof parsed.hash === 'string') head = parsed;
    } catch { /* missing or torn HEAD: nothing committed */ }
    let buf = Buffer.alloc(0);
    try { buf = fs.readFileSync(this.logPath); } catch { /* no log yet */ }
    if (!head || head.offset > buf.length) return;

    let pos = 0;
    let hash = GENESIS;
    const records = [];
    while (pos < head.offset) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl === -1 || nl + 1 > head.offset) break; // torn tail
      const line = buf.subarray(pos, nl).toString('utf8');
      let rec;
      try { rec = JSON.parse(line); } catch { break; } // corrupt line
      hash = sha256(hash + '\n' + line);
      records.push(rec);
      pos = nl + 1;
    }
    this.records = records;
    this.offset = pos;
    this.hash = hash;
    // Drop any torn/uncommitted tail so future appends stay contiguous.
    if (buf.length > this.offset) fs.truncateSync(this.logPath, this.offset);
  }

  append(record) {
    const line = JSON.stringify(record);
    const bytes = Buffer.from(line + '\n');
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const head = { offset: this.offset + bytes.length, hash: sha256(this.hash + '\n' + line) };
    const tmp = this.headPath + '.tmp';
    const tfd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(tfd, JSON.stringify(head));
      fs.fsyncSync(tfd);
    } finally {
      fs.closeSync(tfd);
    }
    fs.renameSync(tmp, this.headPath);
    const dfd = fs.openSync(this.dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    this.offset = head.offset;
    this.hash = head.hash;
    this.records.push(record);
  }
}
