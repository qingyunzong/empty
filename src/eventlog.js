import { open, readFile, stat } from 'node:fs/promises';
import { GENESIS, eventHash } from './hash.js';

// Append-only event stream: one JSON event per line, hash-chained.
// Durability contract: a line is committed only after fsync returns.
export class EventLog {
  constructor(path) {
    this.path = path;
  }

  async size() {
    try {
      return (await stat(this.path)).size;
    } catch {
      return 0;
    }
  }

  async append(data, { sync = true } = {}) {
    const fh = await open(this.path, 'a');
    try {
      await fh.writeFile(data);
      if (sync) await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async truncate(size) {
    const fh = await open(this.path, 'r+');
    try {
      await fh.truncate(size);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  // Parse the log and verify the hash chain event by event. Stops at the
  // first torn/corrupt tail (partial line, bad JSON, broken chain, gap in
  // seq) and reports the byte offset of the last valid event, so recovery
  // can truncate safely.
  static async readVerified(path) {
    let buf;
    try {
      buf = await readFile(path);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { events: [], validBytes: 0, totalBytes: 0, headHash: GENESIS, headSeq: 0, torn: false };
      }
      throw err;
    }
    const text = buf.toString('utf8');
    const events = [];
    let prev = GENESIS;
    let headSeq = 0;
    let pos = 0;
    let torn = false;
    while (pos < text.length) {
      const nl = text.indexOf('\n', pos);
      if (nl === -1) {
        torn = true; // tail without newline: writer died mid-line
        break;
      }
      const line = text.slice(pos, nl);
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        torn = true;
        break;
      }
      const { hash, ...rest } = rec;
      if (
        typeof hash !== 'string' ||
        rec.seq !== headSeq + 1 ||
        eventHash(prev, rest) !== hash
      ) {
        torn = true;
        break;
      }
      events.push(rec);
      prev = hash;
      headSeq = rec.seq;
      pos = nl + 1;
    }
    return { events, validBytes: pos, totalBytes: buf.length, headHash: prev, headSeq, torn };
  }
}
