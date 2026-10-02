import fs from 'node:fs';
import { HEADER, RECORD_TYPE, RECORD_TYPE_NAME, decodeBlock, decodeIndex } from './format.js';
import { LogError, E_CRC, E_FORMAT, E_TRUNCATED } from './errors.js';

// Incremental decoder. Restores the baseline events, then folds corrections
// and tombstones by sequence number into an active view plus a full audit
// history. Blocks are applied atomically: a block that fails CRC aborts the
// update and leaves the previously decoded state untouched.
export class Decoder {
  constructor(path) {
    this.path = path;
    this.reset();
  }

  reset() {
    this.offset = HEADER.length;
    this.events = new Map(); // seq -> event record
    this.corrections = new Map(); // refSeq -> [correction records in seq order]
    this.tombstones = new Map(); // refSeq -> tombstone record
    this.log = []; // every record in arrival order (audit history)
  }

  // Decodes all complete blocks appended since the last update.
  // Throws LogError with code E_CRC when a block fails its checksum; state
  // then contains exactly the records of the blocks before the corrupt one.
  update() {
    const buf = fs.readFileSync(this.path);
    if (buf.length < HEADER.length || !buf.subarray(0, HEADER.length).equals(HEADER)) {
      throw new LogError(E_FORMAT, 'not an EVL1 log file');
    }
    const decoded = decodeIndex(buf);
    const limit = decoded ? decoded.indexStart : buf.length;
    while (this.offset < limit) {
      let block;
      try {
        block = decodeBlock(buf, this.offset);
      } catch (err) {
        if (err.code === E_TRUNCATED) break; // torn tail, retry on next update
        if (err.code === E_FORMAT) break; // garbage tail (e.g. corrupt index bytes)
        throw err;
      }
      this.#apply(block.records);
      this.offset += block.size;
    }
    return this;
  }

  #apply(records) {
    for (const rec of records) {
      this.log.push(rec);
      if (rec.type === RECORD_TYPE.EVENT) {
        this.events.set(rec.seq, rec);
      } else if (rec.type === RECORD_TYPE.CORRECTION) {
        let list = this.corrections.get(rec.refSeq);
        if (!list) {
          list = [];
          this.corrections.set(rec.refSeq, list);
        }
        list.push(rec);
      } else if (rec.type === RECORD_TYPE.TOMBSTONE) {
        this.tombstones.set(rec.refSeq, rec);
      }
    }
  }

  // Active view: baseline events with corrections folded in, tombstoned
  // events removed. Sorted by seq.
  view() {
    const out = [];
    for (const [seq, event] of [...this.events.entries()].sort((a, b) => a[0] - b[0])) {
      if (this.tombstones.has(seq)) continue;
      const record = {
        seq,
        ts: event.ts,
        device: event.device,
        status: event.status,
        payload: event.payload.toString('utf8'),
        corrected: false,
        correctedBy: null,
      };
      for (const corr of this.corrections.get(seq) ?? []) {
        if (corr.device !== undefined) record.device = corr.device;
        if (corr.status !== undefined) record.status = corr.status;
        if (corr.payload !== undefined) record.payload = corr.payload.toString('utf8');
        record.corrected = true;
        record.correctedBy = corr.seq;
      }
      out.push(record);
    }
    return out;
  }

  // Full audit history: every record in arrival order.
  history() {
    return this.log.map((rec) => {
      const entry = {
        seq: rec.seq,
        ts: rec.ts,
        type: RECORD_TYPE_NAME[rec.type],
      };
      if (rec.type === RECORD_TYPE.EVENT) {
        entry.device = rec.device;
        entry.status = rec.status;
        entry.payload = rec.payload.toString('utf8');
      } else {
        entry.refSeq = rec.refSeq;
        entry.reason = rec.reason;
        if (rec.type === RECORD_TYPE.CORRECTION) {
          if (rec.device !== undefined) entry.device = rec.device;
          if (rec.status !== undefined) entry.status = rec.status;
          if (rec.payload !== undefined) entry.payload = rec.payload.toString('utf8');
        }
      }
      return entry;
    });
  }
}
