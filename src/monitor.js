import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DynamicGraph } from './graph.js';
import { OP, encodeRecord, parseLog } from './wal.js';

const MAX_VERTEX = 1_000_000;

export const CRASH_POINTS = ['after_append', 'before_fsync', 'after_index_commit'];

// Combines the dynamic graph with the WAL. Durability rule: a record is
// confirmed once it has been completely appended and fsynced; every
// confirmed record in the log is replayed on recovery. A torn half record
// at the tail (crash after append / before fsync / after index commit) was
// never confirmed: recovery discards it and never applies it — in
// particular a half-written del_edge is NOT treated as a deletion.
// `commit` writes an explicit checkpoint marker (append + fsync).
export class Monitor {
  constructor(logPath, { autoRecover = true } = {}) {
    this.logPath = logPath;
    this.graph = new DynamicGraph();
    this.seq = 0;
    if (autoRecover) this.recover();
  }

  static validVertex(x) {
    return Number.isInteger(x) && x >= 0 && x <= MAX_VERTEX;
  }

  #append(record) {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, encodeRecord(record));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.seq = record.seq;
  }

  addEdge(u, v) {
    if (!Monitor.validVertex(u) || !Monitor.validVertex(v) || u === v) return 'INVALID_INPUT';
    this.#append({ seq: this.seq + 1, op: OP.ADD, u, v });
    this.graph.addEdge(u, v); // idempotent: duplicate edges are no-ops
    return 'OK';
  }

  delEdge(u, v) {
    if (!Monitor.validVertex(u) || !Monitor.validVertex(v) || u === v) return 'INVALID_INPUT';
    if (!this.graph.hasEdge(u, v)) return 'NO_SUCH_EDGE';
    this.#append({ seq: this.seq + 1, op: OP.DEL, u, v });
    this.graph.delEdge(u, v);
    return 'OK';
  }

  commit() {
    this.#append({ seq: this.seq + 1, op: OP.COMMIT });
    return 'OK';
  }

  queryBridges() {
    return this.graph.bridges();
  }

  queryArticulation() {
    return this.graph.articulationPoints();
  }

  stateHash() {
    const canonical = this.graph.edges().map(([a, b]) => `${a},${b}`).join('\n');
    return createHash('sha256').update(canonical).digest('hex');
  }

  // Replays every confirmed (complete, crc-valid) record, discards the
  // torn half record at the tail if present, truncates the log to the
  // confirmed prefix and returns { applied, discarded, state_hash }.
  recover() {
    let buf;
    try {
      buf = fs.readFileSync(this.logPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      buf = Buffer.alloc(0);
    }
    const { records, partial } = parseLog(buf); // throws PersistCorruptError

    this.graph = new DynamicGraph();
    let applied = 0;
    for (const r of records) {
      if (r.op === OP.ADD) {
        this.graph.addEdge(r.u, r.v);
        applied += 1;
      } else if (r.op === OP.DEL) {
        this.graph.delEdge(r.u, r.v);
        applied += 1;
      }
      // commit records are durability checkpoints: nothing to replay
    }
    const discarded = partial ? 1 : 0;

    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    const fd = fs.openSync(this.logPath, 'w');
    try {
      for (const r of records) fs.writeSync(fd, encodeRecord(r));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.seq = records.length ? records[records.length - 1].seq : 0;
    return { applied, discarded, state_hash: this.stateHash() };
  }

  // Simulates a crash at one of the three fault points by injecting
  // truncated bytes into the log file:
  //  - after_append:        torn write of the next data record (a del_edge
  //                         that recovery must NOT mistake for a deletion)
  //  - before_fsync:        tail bytes of the last record lost before fsync
  //  - after_index_commit:  torn write of the commit/checkpoint record
  crashSim(point) {
    const p = String(point);
    const rawAppend = (bytes) => {
      const fd = fs.openSync(this.logPath, 'a');
      try {
        fs.writeSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    };
    const halfOf = (record) => {
      const bytes = Buffer.from(encodeRecord(record), 'utf8');
      return bytes.subarray(0, Math.floor(bytes.length / 2));
    };

    if (p === 'after_append' || p === '1') {
      const edges = this.graph.edges();
      const rec = edges.length > 0
        ? { seq: this.seq + 1, op: OP.DEL, u: edges[0][0], v: edges[0][1] }
        : { seq: this.seq + 1, op: OP.ADD, u: 0, v: 1 };
      rawAppend(halfOf(rec));
      return 'OK';
    }
    if (p === 'before_fsync' || p === '2') {
      let buf;
      try {
        buf = fs.readFileSync(this.logPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        return 'OK'; // empty log: nothing to lose
      }
      if (buf.length === 0) return 'OK';
      const nl = buf.lastIndexOf(0x0a, Math.max(0, buf.length - 2));
      const lineStart = nl + 1;
      const cut = lineStart + Math.max(1, Math.floor((buf.length - lineStart) / 2));
      const fd = fs.openSync(this.logPath, 'r+');
      try {
        fs.ftruncateSync(fd, cut);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return 'OK';
    }
    if (p === 'after_index_commit' || p === '3') {
      rawAppend(halfOf({ seq: this.seq + 1, op: OP.COMMIT }));
      return 'OK';
    }
    return 'INVALID_INPUT';
  }
}
