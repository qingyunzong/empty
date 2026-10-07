import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Write-ahead log with two files:
//   segments.log  - JSON record payloads, append-only
//   index.log     - commit records {txId, offset, len, sha1}, append-only
// A transaction is committed by writing+fsyncing its segment, then
// writing+fsyncing its index entry. The defined crash point is between the
// two writes; on recovery any segment without a valid index entry is
// truncated, so a transaction is either fully visible or not visible at all.
export class Wal {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.segPath = path.join(dir, 'segments.log');
    this.idxPath = path.join(dir, 'index.log');
    for (const p of [this.segPath, this.idxPath]) {
      if (!fs.existsSync(p)) fs.writeFileSync(p, '');
    }
    this._recover();
  }

  _appendSync(file, buf) {
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  _recover() {
    const seg = fs.readFileSync(this.segPath);
    const lines = fs.readFileSync(this.idxPath, 'utf8').split('\n');
    this.records = [];
    const validLines = [];
    let validEnd = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let ent;
      try {
        ent = JSON.parse(line);
      } catch {
        break; // torn index tail
      }
      if (typeof ent.offset !== 'number' || typeof ent.len !== 'number' || typeof ent.sha1 !== 'string') break;
      const slice = seg.subarray(ent.offset, ent.offset + ent.len);
      if (slice.length !== ent.len) break;
      const sha1 = crypto.createHash('sha1').update(slice).digest('hex');
      if (sha1 !== ent.sha1) break;
      this.records.push(JSON.parse(slice.toString('utf8')));
      validLines.push(line);
      validEnd = Math.max(validEnd, ent.offset + ent.len);
    }
    if (validEnd < seg.length) {
      const fd = fs.openSync(this.segPath, 'r+');
      try {
        fs.ftruncateSync(fd, validEnd);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const idxContent = validLines.length ? validLines.join('\n') + '\n' : '';
    if (fs.readFileSync(this.idxPath, 'utf8') !== idxContent) {
      fs.writeFileSync(this.idxPath, idxContent);
    }
    this.nextTxId = this.records.reduce((m, r) => Math.max(m, (r.txId ?? -1) + 1), 0);
  }

  append(record) {
    const txId = this.nextTxId++;
    const payload = Buffer.from(JSON.stringify({ txId, ...record }) + '\n', 'utf8');
    const offset = fs.statSync(this.segPath).size;
    this._appendSync(this.segPath, payload);
    if (process.env.TRACE_CRASH_POINT === 'after_segment') {
      // Fault-injection hook for crash testing: die after the segment write,
      // before the index write (the defined failure point).
      process.kill(process.pid, 'SIGKILL');
    }
    const sha1 = crypto.createHash('sha1').update(payload).digest('hex');
    const line = Buffer.from(JSON.stringify({ txId, offset, len: payload.length, sha1 }) + '\n', 'utf8');
    this._appendSync(this.idxPath, line);
    return txId;
  }
}
