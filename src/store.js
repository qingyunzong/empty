// Local transactional KV store backed by a write-ahead log.
//
// Each committed transaction is appended to wal.log as one checksummed JSON
// line carrying a vector clock and a commit-graph frontier (parents), so the
// WAL doubles as the exportable log segment. On open, the WAL is replayed;
// corrupt lines are skipped and counted (crash recovery).
//
// The merged state is a deterministic function of the known transaction set:
// replay all transactions in canonical order (causal topo order, id
// tie-break). Every replica that has imported the same segments therefore
// converges to the same state.
import fs from 'node:fs';
import path from 'node:path';
import { clockLe, clockLt, clockMerge } from './clock.js';
import { encodeEntry, decodeEntryLine, encodeSegment, decodeSegment } from './segment.js';
import { canonicalOrder, replayState, checkSerializable } from './serialize.js';

export class Store {
  static open(dir, site) {
    return new Store(dir, site);
  }

  constructor(dir, site) {
    this.dir = dir;
    this.site = site;
    this.walPath = path.join(dir, 'wal.log');
    fs.mkdirSync(dir, { recursive: true });
    this.txns = new Map(); // id -> txn
    this.clock = {}; // vector clock: element-wise max of all known txn clocks
    this.corruptLines = 0; // corrupt WAL lines skipped during recovery
    if (fs.existsSync(this.walPath)) this.#loadWal();
  }

  #loadWal() {
    const text = fs.readFileSync(this.walPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const txn = decodeEntryLine(line);
        if (!this.txns.has(txn.id)) {
          this.txns.set(txn.id, txn);
          this.clock = clockMerge(this.clock, txn.clock);
        }
      } catch {
        this.corruptLines++;
      }
    }
  }

  #appendWal(txn) {
    fs.appendFileSync(this.walPath, encodeEntry(txn) + '\n');
  }

  #frontier() {
    const all = [...this.txns.values()];
    return all
      .filter((t) => !all.some((o) => o.id !== t.id && clockLt(t.clock, o.clock)))
      .map((t) => t.id)
      .sort();
  }

  // Merged state over all known transactions (deterministic).
  get state() {
    const txns = [...this.txns.values()];
    return replayState(txns, canonicalOrder(txns));
  }

  // Commit a transaction: read `reads` keys from the current merged state,
  // then apply `writes`. Records the observed read values, a vector clock,
  // and the commit-graph frontier.
  commit({ reads = [], writes = {} }) {
    for (const [k, v] of Object.entries(writes)) {
      if (v === null || v === undefined) {
        throw new Error(`null/undefined write not allowed (key ${k})`);
      }
    }
    const st = this.state;
    const readSet = {};
    for (const k of reads) readSet[k] = st[k] ?? null;
    this.clock[this.site] = (this.clock[this.site] ?? 0) + 1;
    const id = `${this.site}:${this.clock[this.site]}`;
    const txn = {
      id,
      site: this.site,
      clock: { ...this.clock },
      parents: this.#frontier(),
      reads: readSet,
      writes,
    };
    this.txns.set(id, txn);
    this.#appendWal(txn);
    return txn;
  }

  // Read a key from the merged state, or from the causal snapshot at clock
  // `at` (only transactions causally <= at are visible).
  read(key, { at } = {}) {
    if (!at) return this.state[key] ?? null;
    const sub = [...this.txns.values()].filter((t) => clockLe(t.clock, at));
    return replayState(sub, canonicalOrder(sub))[key] ?? null;
  }

  // Export a log segment. With `since` (a vector clock), only transactions
  // not already causally covered by it are included.
  exportSegment({ since } = {}) {
    const txns = [...this.txns.values()].filter((t) => !since || !clockLe(t.clock, since));
    return encodeSegment(txns, this.site);
  }

  // Merge an external log segment. Idempotent: already-known transaction ids
  // are skipped. Corrupt entries are skipped and reported as CORRUPT.
  importSegment(text) {
    const { txns, corrupt } = decodeSegment(text);
    let imported = 0;
    let duplicates = 0;
    for (const txn of txns) {
      if (this.txns.has(txn.id)) {
        duplicates++;
        continue;
      }
      this.txns.set(txn.id, txn);
      this.clock = clockMerge(this.clock, txn.clock);
      this.#appendWal(txn);
      imported++;
    }
    return { imported, duplicates, corrupt, status: corrupt ? 'CORRUPT' : 'OK' };
  }

  // Check whether the merged history is serializable and, if so, equivalent
  // to replaying the returned order (which must reproduce the merged state).
  check() {
    return checkSerializable([...this.txns.values()], this.state);
  }
}
