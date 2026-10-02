'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Write-ahead log with a segment/index commit protocol.
//
// Commit of a record batch:
//   1. append JSON line(s) to the current segment file + fsync
//   2. atomically replace index.json with { committed: <lsn> } + fsync
//
// The fault point is between (1) and (2): a record whose bytes reached the
// segment but whose lsn never reached the index is invisible after
// recovery. A committed batch is therefore either fully visible or fully
// invisible -- never partially.
class Wal {
  constructor(dir) {
    this.dir = dir;
    this.walDir = path.join(dir, 'wal');
    this.indexPath = path.join(this.walDir, 'index.json');
    this.snapshotPath = path.join(dir, 'snapshot.json');
    fs.mkdirSync(this.walDir, { recursive: true });
    const index = this.#readIndex();
    this.segment = index.segment;
    this.committed = index.committed;
    this.segmentPath = path.join(this.walDir, `seg-${String(this.segment).padStart(6, '0')}.log`);
    if (!fs.existsSync(this.segmentPath)) fs.writeFileSync(this.segmentPath, '');
    this.#truncateUncommittedTail();
  }

  // Recovery: drop records that reached the segment but never the index.
  // Without this, their lsns would be reused by future commits and the
  // aborted records would resurrect on the next recovery.
  #truncateUncommittedTail() {
    const text = fs.readFileSync(this.segmentPath, 'utf8');
    const kept = [];
    let dirty = false;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec = null;
      try {
        rec = JSON.parse(line);
      } catch {
        rec = null;
      }
      if (rec && rec.lsn <= this.committed) kept.push(line);
      else dirty = true;
    }
    if (dirty) {
      const fd = fs.openSync(this.segmentPath, 'w');
      try {
        fs.writeSync(fd, kept.length ? kept.join('\n') + '\n' : '');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }

  #readIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      return { committed: parsed.committed, segment: parsed.segment };
    } catch {
      return { committed: 0, segment: 1 };
    }
  }

  static atomicWrite(filePath, contents) {
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, filePath);
  }

  // Append one committed record batch (array of records sharing lsn range).
  append(lsn, records) {
    const lines = records.map((r) => JSON.stringify({ lsn, ...r })).join('\n') + '\n';
    const fd = fs.openSync(this.segmentPath, 'a');
    try {
      fs.writeSync(fd, lines);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // --- fault point: segment durable, index not yet ---
    if (process.env.WAL_CRASH_AFTER_SEGMENT === '1') {
      process.kill(process.pid, 'SIGKILL');
    }
    Wal.atomicWrite(this.indexPath, JSON.stringify({ committed: lsn, segment: this.segment }));
    try {
      const dfd = fs.openSync(this.walDir, 'r');
      fs.fsyncSync(dfd);
      fs.closeSync(dfd);
    } catch {
      /* directory fsync unsupported; index rename is still atomic */
    }
    this.committed = lsn;
  }

  // Replay only records with lsn <= committed (and > baseLsn from snapshot).
  replay(baseLsn = 0) {
    const records = [];
    const segs = fs.readdirSync(this.walDir)
      .filter((n) => /^seg-\d+\.log$/.test(n))
      .sort();
    for (const name of segs) {
      const p = path.join(this.walDir, name);
      const text = fs.readFileSync(p, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // torn tail write: ignore
        }
        if (rec.lsn > baseLsn && rec.lsn <= this.committed) records.push(rec);
      }
    }
    records.sort((a, b) => a.lsn - b.lsn);
    return records;
  }

  loadSnapshot() {
    try {
      return JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
    } catch {
      return null;
    }
  }

  // Persist snapshot and truncate the log: new empty segment, index reset
  // to the snapshot base lsn.
  writeSnapshot(baseLsn, state) {
    Wal.atomicWrite(
      this.snapshotPath,
      JSON.stringify({ baseLsn, state }),
    );
    for (const name of fs.readdirSync(this.walDir)) {
      if (name.startsWith('seg-')) fs.unlinkSync(path.join(this.walDir, name));
    }
    this.segment += 1;
    this.segmentPath = path.join(this.walDir, `seg-${String(this.segment).padStart(6, '0')}.log`);
    fs.writeFileSync(this.segmentPath, '');
    Wal.atomicWrite(this.indexPath, JSON.stringify({ committed: baseLsn, segment: this.segment }));
    this.committed = baseLsn;
  }
}

module.exports = { Wal };
