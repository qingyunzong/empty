import fs from 'node:fs';
import { crc32 } from './crc32.js';
import {
  KIND, KIND_NAME, CorruptError,
  encodeBlock, decodeBlock, encodeIndex, decodeIndex,
} from './format.js';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.block = null;
    this.exitCode = 1;
  }
}

export function initialState() {
  return { blocks: 0, balance: 0, frozen: 0, txs: {} };
}

const availableOf = (s) => s.balance - s.frozen;

function requireAmount(ev) {
  if (!Number.isSafeInteger(ev.amount) || ev.amount <= 0) {
    throw new LedgerError('INVALID_AMOUNT', `amount must be a positive safe integer, got ${ev.amount}`);
  }
}

// Pure state transition; throws LedgerError on business-rule rejection.
export function applyEvent(state, ev) {
  const kind = KIND_NAME[ev.kind];
  switch (kind) {
    case 'credit': {
      requireAmount(ev);
      if (state.txs[ev.txid]) throw new LedgerError('DUPLICATE_TXID', `txid ${ev.txid} already exists`);
      state.balance += ev.amount;
      state.txs[ev.txid] = { kind: 'credit', amount: ev.amount, status: 'active' };
      return;
    }
    case 'debit': {
      requireAmount(ev);
      if (state.txs[ev.txid]) throw new LedgerError('DUPLICATE_TXID', `txid ${ev.txid} already exists`);
      if (availableOf(state) < ev.amount) {
        throw new LedgerError('INSUFFICIENT_FUNDS', `available ${availableOf(state)} < debit ${ev.amount}`);
      }
      state.balance -= ev.amount;
      state.txs[ev.txid] = { kind: 'debit', amount: ev.amount, status: 'active' };
      return;
    }
    case 'cancel': {
      const t = state.txs[ev.target];
      if (!t) throw new LedgerError('TX_NOT_FOUND', `tx ${ev.target} does not exist`);
      if (t.status === 'cancelled') throw new LedgerError('ALREADY_CANCELLED', `tx ${ev.target} already cancelled`);
      if (t.status === 'frozen') throw new LedgerError('TX_FROZEN', `tx ${ev.target} is frozen; cancel conflicts with freeze`);
      if (t.kind !== 'credit' && t.kind !== 'debit') throw new LedgerError('NOT_CANCELLABLE', `tx ${ev.target} of kind ${t.kind} cannot be cancelled`);
      if (t.kind === 'credit') state.balance -= t.amount;
      else state.balance += t.amount;
      t.status = 'cancelled';
      return;
    }
    case 'freeze': {
      const t = state.txs[ev.target];
      if (!t) throw new LedgerError('TX_NOT_FOUND', `tx ${ev.target} does not exist`);
      if (t.status === 'cancelled') throw new LedgerError('ALREADY_CANCELLED', `tx ${ev.target} already cancelled`);
      if (t.status === 'frozen') throw new LedgerError('ALREADY_FROZEN', `tx ${ev.target} already frozen`);
      if (t.kind !== 'credit' && t.kind !== 'debit') throw new LedgerError('NOT_FREEZABLE', `tx ${ev.target} of kind ${t.kind} cannot be frozen`);
      if (availableOf(state) < t.amount) {
        throw new LedgerError('INSUFFICIENT_FUNDS', `available ${availableOf(state)} < freeze ${t.amount}`);
      }
      state.frozen += t.amount; // freeze never touches balance
      t.status = 'frozen';
      return;
    }
    case 'settle': {
      requireAmount(ev);
      if (state.txs[ev.txid]) throw new LedgerError('DUPLICATE_TXID', `txid ${ev.txid} already exists`);
      // Settlement only checks available = balance - frozen.
      if (availableOf(state) < ev.amount) {
        throw new LedgerError('INSUFFICIENT_FUNDS', `available ${availableOf(state)} < settle ${ev.amount}`);
      }
      state.balance -= ev.amount;
      state.txs[ev.txid] = { kind: 'settle', amount: ev.amount, status: 'active' };
      return;
    }
    default:
      throw new LedgerError('UNKNOWN_KIND', `unknown event kind ${ev.kind}`);
  }
}

export class Ledger {
  constructor(file) {
    this.file = file;
    this.datFile = file;
    this.idxFile = `${file}.idx`;
    this.stateFile = `${file}.state.json`;
    this.entries = null; // null => index missing/unreadable
    this.state = initialState();
  }

  static open(file) {
    const l = new Ledger(file);
    l.#load();
    return l;
  }

  #load() {
    if (fs.existsSync(this.idxFile)) {
      try {
        this.entries = decodeIndex(fs.readFileSync(this.idxFile));
      } catch {
        this.entries = null; // torn index write; require verify --rebuild
      }
    }
    if (fs.existsSync(this.stateFile)) {
      this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    }
    if (this.entries) this.#catchUp();
  }

  // Incremental decode: resume exactly at the block the persisted state
  // stopped at, seeking via the index. Never scans the data file.
  #catchUp() {
    while (this.state.blocks < this.entries.length) {
      const i = this.state.blocks;
      const block = this.#readIndexedBlock(i);
      for (const tx of block.txs) applyEvent(this.state, tx);
      this.state.blocks += 1;
    }
  }

  #readIndexedBlock(i) {
    const entry = this.entries[i];
    const prevCrc = i > 0 ? this.entries[i - 1].crc : 0;
    const fd = fs.openSync(this.datFile, 'r');
    let buf;
    try {
      buf = Buffer.alloc(entry.length);
      fs.readSync(fd, buf, 0, entry.length, entry.offset);
    } finally {
      fs.closeSync(fd);
    }
    const block = decodeBlock(buf, { offset: entry.offset, expectedSeq: entry.seq, expectedPrevCrc: prevCrc });
    if (block.crc !== entry.crc) throw new CorruptError(entry.seq, 'index CRC does not match block');
    return block;
  }

  #datSize() {
    return fs.existsSync(this.datFile) ? fs.statSync(this.datFile).size : 0;
  }

  #indexedEnd() {
    if (!this.entries || this.entries.length === 0) return 0;
    const last = this.entries[this.entries.length - 1];
    return last.offset + last.length;
  }

  #assertWritable() {
    if (!this.entries) {
      if (this.#datSize() > 0) {
        throw new LedgerError('INDEX_MISSING', 'index missing or unreadable; run: verify --rebuild');
      }
      this.entries = [];
      return;
    }
    if (this.#datSize() !== this.#indexedEnd()) {
      throw new LedgerError(
        'ORPHAN_BLOCKS',
        'data file contains blocks not covered by the index (crash between block fsync and index update); run: verify --rebuild'
      );
    }
  }

  // Validate + append one block containing the given events.
  // Write order: block bytes + fsync -> index + fsync -> state snapshot.
  appendEvents(events) {
    if (events.length === 0) throw new LedgerError('EMPTY_BLOCK', 'no events to append');
    this.#assertWritable();
    const next = structuredClone(this.state);
    for (const ev of events) applyEvent(next, ev); // rejected => nothing is written

    const seq = this.entries.length;
    const offset = this.#datSize();
    const prevCrc = seq > 0 ? this.entries[seq - 1].crc : 0;
    const buf = encodeBlock({ seq, startOffset: offset, prevCrc, txs: events });

    const fd = fs.openSync(this.datFile, 'a');
    try {
      fs.writeSync(fd, buf, 0, buf.length);
      fs.fsyncSync(fd); // <-- defined crash point: after this, before index update
    } finally {
      fs.closeSync(fd);
    }

    this.entries.push({ seq, offset, length: buf.length, crc: crc32(buf.subarray(0, buf.length - 4)) });
    this.#writeIndex();

    this.state = next;
    this.state.blocks = seq + 1;
    this.#writeState();
    return { seq, offset, length: buf.length };
  }

  append({ txid, kind, amount }) {
    if (txid.startsWith('~')) throw new LedgerError('RESERVED_TXID', 'txids starting with ~ are reserved');
    return this.appendEvents([{ txid, kind: KIND[kind], amount, target: null }]);
  }

  cancel(target) {
    return this.appendEvents([{ txid: this.#autoTxid(), kind: KIND.cancel, amount: 0, target }]);
  }

  freeze(target) {
    return this.appendEvents([{ txid: this.#autoTxid(), kind: KIND.freeze, amount: 0, target }]);
  }

  settle({ txid, amount }) {
    return this.appendEvents([{ txid: txid ?? this.#autoTxid(), kind: KIND.settle, amount, target: null }]);
  }

  #autoTxid() {
    return `~${this.entries ? this.entries.length : 0}`;
  }

  // Sequential audit scan of the whole data file (recovery path only).
  // With rebuild: rewrites the index (and derived state) from the valid
  // prefix; on corruption the bad block and everything after it are cut off.
  verify({ rebuild = false } = {}) {
    const size = this.#datSize();
    const buf = size > 0 ? fs.readFileSync(this.datFile) : Buffer.alloc(0);
    const entries = [];
    let offset = 0;
    let prevCrc = 0;
    let seq = 0;
    while (offset < size) {
      let block;
      try {
        block = decodeBlock(buf.subarray(offset), { offset, expectedSeq: seq, expectedPrevCrc: prevCrc });
      } catch (err) {
        if (err instanceof CorruptError && rebuild) {
          this.#installRecovered(entries, offset);
        }
        throw err;
      }
      entries.push({ seq, offset, length: block.length, crc: block.crc });
      prevCrc = block.crc;
      offset += block.length;
      seq += 1;
    }

    if (rebuild) {
      this.#installRecovered(entries, offset);
    } else if (this.entries) {
      const diverged = this.#firstDivergence(entries, this.entries);
      if (diverged !== null) {
        const err = new LedgerError('INDEX_MISMATCH', `index diverges from data at block ${diverged}; run: verify --rebuild`);
        err.block = diverged;
        err.exitCode = 2;
        throw err;
      }
    }
    return { blocks: entries.length };
  }

  #firstDivergence(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i];
      const y = b[i];
      if (!x || !y) return i;
      if (x.seq !== y.seq || x.offset !== y.offset || x.length !== y.length || x.crc !== y.crc) return i;
    }
    return null;
  }

  #installRecovered(entries, validEnd) {
    this.entries = entries;
    this.#writeIndex();
    if (this.#datSize() !== validEnd) fs.truncateSync(this.datFile, validEnd);
    this.#rebuildState();
  }

  #rebuildState() {
    const st = initialState();
    for (let i = 0; i < this.entries.length; i++) {
      const block = this.#readIndexedBlock(i);
      for (const tx of block.txs) applyEvent(st, tx);
      st.blocks += 1;
    }
    this.state = st;
    this.#writeState();
  }

  dump() {
    if (!this.entries) {
      if (this.#datSize() > 0) {
        throw new LedgerError('INDEX_MISSING', 'index missing or unreadable; run: verify --rebuild');
      }
      this.entries = [];
    }
    return {
      blocks: this.entries.length,
      balance: this.state.balance,
      frozen: this.state.frozen,
      available: availableOf(this.state),
      txs: structuredClone(this.state.txs),
    };
  }

  #writeIndex() {
    const tmp = `${this.idxFile}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, encodeIndex(this.entries));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.idxFile);
  }

  #writeState() {
    const tmp = `${this.stateFile}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.stateFile);
  }
}
