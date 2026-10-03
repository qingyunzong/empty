import fs from 'node:fs';
import path from 'node:path';
import { QrecError } from './errors.js';
import { encodeChunk, decodeChunk, RecordType } from './chunk.js';

export const SCALE = 1_000_000;

export function toScaled(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new QrecError('E_VALUE', `invalid numeric value: ${v}`);
  }
  const s = Math.round(v * SCALE);
  if (!Number.isSafeInteger(s)) throw new QrecError('E_VALUE', `value out of range: ${v}`);
  return s;
}

const MANIFEST = 'manifest.json';

function emptyManifest() {
  return { version: 1, nextChunkSeq: 0, batches: {}, chunks: [] };
}

export class Store {
  static open(dir, opts = {}) {
    const store = new Store(dir, opts);
    store._load();
    return store;
  }

  constructor(dir, { maxRecordsPerChunk = 128, strict = true } = {}) {
    this.dir = dir;
    this.maxRecordsPerChunk = maxRecordsPerChunk;
    this.strict = strict;
    this.errors = [];
    this.manifest = emptyManifest();
    this._batches = new Map();
  }

  _load() {
    const mpath = path.join(this.dir, MANIFEST);
    if (fs.existsSync(mpath)) {
      this.manifest = JSON.parse(fs.readFileSync(mpath, 'utf8'));
    }
    for (const [id, meta] of Object.entries(this.manifest.batches)) {
      this._batches.set(id, {
        id,
        baselineScaled: meta.baselineScaled,
        toleranceScaled: meta.toleranceScaled,
        records: [],
        chainValueScaled: meta.baselineScaled,
        nextSeq: 1,
        timeIndex: [],
      });
    }
    for (const entry of this.manifest.chunks) {
      try {
        const buf = fs.readFileSync(path.join(this.dir, 'chunks', entry.file));
        const chunk = decodeChunk(buf);
        this._applyChunk(chunk);
      } catch (err) {
        const qerr =
          err instanceof QrecError ? err : new QrecError('E_IO', String(err.message || err));
        qerr.file = entry.file;
        this.errors.push({ code: qerr.code, file: entry.file, message: qerr.message });
        if (this.strict) throw qerr;
        break; // isolate: nothing at or after the bad chunk is applied
      }
    }
    for (const st of this._batches.values()) this._reindex(st);
  }

  _applyChunk(chunk) {
    const st = this._batches.get(chunk.batchId);
    if (!st) throw new QrecError('E_BATCH', `chunk for unknown batch: ${chunk.batchId}`);
    for (const r of chunk.records) {
      if (r.type === RecordType.COMPENSATE) {
        const known = st.records.some(
          (x) => x.type === RecordType.MEASURE && x.seq === r.targetSeq
        );
        if (!known) {
          throw new QrecError(
            'E_REFERENCE',
            `compensation references unknown measurement seq ${r.targetSeq} in batch ${chunk.batchId}`
          );
        }
      }
      st.records.push(r);
      st.chainValueScaled = r.valueScaled;
      if (r.type === RecordType.MEASURE && r.seq >= st.nextSeq) st.nextSeq = r.seq + 1;
    }
  }

  _reindex(st) {
    st.timeIndex = st.records
      .map((r, idx) => ({ time: r.time, idx }))
      .sort((a, b) => a.time - b.time || a.idx - b.idx);
  }

  _requireBatch(batchId) {
    const st = this._batches.get(batchId);
    if (!st) throw new QrecError('E_NOTFOUND', `unknown batch: ${batchId}`);
    return st;
  }

  _writeFileAtomic(destAbs, buf) {
    const tmp = `${destAbs}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, destAbs);
  }

  // Commit: chunk data files first (tmp + rename), then manifest (tmp + rename).
  // A crash before the manifest rename leaves orphan chunk files that are
  // invisible to every future open, because only manifest entries are scanned.
  _commit(batchId, records, mutateManifest) {
    fs.mkdirSync(path.join(this.dir, 'chunks'), { recursive: true });
    const st = this._batches.get(batchId);
    let chain = st ? st.chainValueScaled : records[0].valueScaled;
    const newEntries = [];
    for (let i = 0; i < records.length; i += this.maxRecordsPerChunk) {
      const group = records.slice(i, i + this.maxRecordsPerChunk);
      const chunkSeq = this.manifest.nextChunkSeq + newEntries.length;
      const file = `chunk-${String(chunkSeq).padStart(6, '0')}.bin`;
      const buf = encodeChunk({
        chunkSeq,
        batchId,
        baseTime: group[0].time,
        baseValueScaled: chain,
        records: group,
      });
      this._writeFileAtomic(path.join(this.dir, 'chunks', file), buf);
      newEntries.push({ file, batchId, records: group.length });
      chain = group[group.length - 1].valueScaled;
    }
    const next = {
      ...this.manifest,
      nextChunkSeq: this.manifest.nextChunkSeq + newEntries.length,
      chunks: [...this.manifest.chunks, ...newEntries],
    };
    if (mutateManifest) mutateManifest(next);
    this._writeFileAtomic(
      path.join(this.dir, MANIFEST),
      Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8')
    );
    this.manifest = next;
    for (const entry of newEntries) {
      const buf = fs.readFileSync(path.join(this.dir, 'chunks', entry.file));
      this._applyChunk(decodeChunk(buf));
    }
    this._reindex(this._batches.get(batchId));
  }

  createBatch(batchId, { baseline, tolerance, time = Date.now() }) {
    if (this._batches.has(batchId)) {
      throw new QrecError('E_BATCH', `batch already exists: ${batchId}`);
    }
    const baselineScaled = toScaled(baseline);
    const toleranceScaled = toScaled(tolerance);
    if (toleranceScaled < 0) throw new QrecError('E_VALUE', 'tolerance must be >= 0');
    this._batches.set(batchId, {
      id: batchId,
      baselineScaled,
      toleranceScaled,
      records: [],
      chainValueScaled: baselineScaled,
      nextSeq: 1,
      timeIndex: [],
    });
    this._commit(
      batchId,
      [{ type: RecordType.BASELINE, time, valueScaled: baselineScaled }],
      (m) => {
        m.batches = {
          ...m.batches,
          [batchId]: { baselineScaled, toleranceScaled, createdAt: time },
        };
      }
    );
  }

  append(batchId, { value, time = Date.now() }) {
    const st = this._requireBatch(batchId);
    const record = { type: RecordType.MEASURE, seq: st.nextSeq, time, valueScaled: toScaled(value) };
    this._commit(batchId, [record]);
    return record.seq;
  }

  appendMany(batchId, items) {
    const st = this._requireBatch(batchId);
    const records = items.map((it, i) => ({
      type: RecordType.MEASURE,
      seq: st.nextSeq + i,
      time: it.time ?? Date.now(),
      valueScaled: toScaled(it.value),
    }));
    this._commit(batchId, records);
    return records.map((r) => r.seq);
  }

  correct(batchId, targetSeq, { value, reason = '', time = Date.now() }) {
    const st = this._requireBatch(batchId);
    const known = st.records.some((r) => r.type === RecordType.MEASURE && r.seq === targetSeq);
    if (!known) {
      throw new QrecError(
        'E_REFERENCE',
        `compensation references unknown measurement seq ${targetSeq} in batch ${batchId}`
      );
    }
    this._commit(batchId, [
      {
        type: RecordType.COMPENSATE,
        targetSeq,
        time,
        valueScaled: toScaled(value),
        reason: String(reason),
      },
    ]);
  }

  _within(st, valueScaled) {
    return Math.abs(valueScaled - st.baselineScaled) <= st.toleranceScaled;
  }

  // Incremental decode: replays records in append order (optionally only the
  // first `upToRecords`), yielding original history, effective values,
  // pass/fail judgment and correction reasons.
  decode(batchId, { upToRecords = Number.POSITIVE_INFINITY } = {}) {
    const st = this._requireBatch(batchId);
    const history = [];
    const effective = new Map();
    const corrections = [];
    const records = st.records.slice(0, Math.min(upToRecords, st.records.length));
    records.forEach((r, index) => {
      if (r.type === RecordType.BASELINE) {
        history.push({
          index,
          type: 'baseline',
          time: r.time,
          value: r.valueScaled / SCALE,
          valueScaled: r.valueScaled,
        });
      } else if (r.type === RecordType.MEASURE) {
        effective.set(r.seq, {
          valueScaled: r.valueScaled,
          time: r.time,
          recordIndex: index,
          corrected: false,
          reason: null,
        });
        history.push({
          index,
          type: 'measurement',
          seq: r.seq,
          time: r.time,
          value: r.valueScaled / SCALE,
          valueScaled: r.valueScaled,
          passes: this._within(st, r.valueScaled),
          superseded: false,
        });
      } else {
        const prev = effective.get(r.targetSeq);
        effective.set(r.targetSeq, {
          valueScaled: r.valueScaled,
          time: r.time,
          recordIndex: index,
          corrected: true,
          reason: r.reason,
        });
        corrections.push({
          index,
          targetSeq: r.targetSeq,
          time: r.time,
          reason: r.reason,
          oldValue: prev ? prev.valueScaled / SCALE : null,
          newValue: r.valueScaled / SCALE,
        });
        history.push({
          index,
          type: 'compensation',
          targetSeq: r.targetSeq,
          time: r.time,
          value: r.valueScaled / SCALE,
          valueScaled: r.valueScaled,
          reason: r.reason,
        });
      }
    });
    for (const h of history) {
      if (h.type === 'measurement') {
        h.superseded = effective.get(h.seq).recordIndex !== h.index;
      }
    }
    const measurements = [...effective.entries()].map(([seq, e]) => ({
      seq,
      value: e.valueScaled / SCALE,
      valueScaled: e.valueScaled,
      time: e.time,
      corrected: e.corrected,
      reason: e.reason,
      passes: this._within(st, e.valueScaled),
    }));
    const failures = measurements.filter((m) => !m.passes).map((m) => m.seq);
    return {
      batchId,
      baseline: st.baselineScaled / SCALE,
      baselineScaled: st.baselineScaled,
      tolerance: st.toleranceScaled / SCALE,
      toleranceScaled: st.toleranceScaled,
      recordCount: records.length,
      history,
      effective: measurements,
      corrections,
      judgment: { pass: failures.length === 0, failures },
    };
  }

  // Index lookup: latest record (any type) with time <= `time` in a batch.
  locate(batchId, time) {
    const st = this._requireBatch(batchId);
    const idx = st.timeIndex;
    let lo = 0;
    let hi = idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (idx[mid].time <= time) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return null;
    const rec = st.records[idx[lo - 1].idx];
    return this._publicRecord(rec, idx[lo - 1].idx);
  }

  // Index lookup: all records with from <= time <= to, ordered by time.
  query(batchId, { from = -Infinity, to = Infinity } = {}) {
    const st = this._requireBatch(batchId);
    return st.timeIndex
      .filter((e) => e.time >= from && e.time <= to)
      .map((e) => this._publicRecord(st.records[e.idx], e.idx));
  }

  _publicRecord(r, index) {
    const base = {
      index,
      time: r.time,
      value: r.valueScaled / SCALE,
      valueScaled: r.valueScaled,
    };
    if (r.type === RecordType.BASELINE) return { ...base, type: 'baseline' };
    if (r.type === RecordType.MEASURE) return { ...base, type: 'measurement', seq: r.seq };
    return { ...base, type: 'compensation', targetSeq: r.targetSeq, reason: r.reason };
  }
}
