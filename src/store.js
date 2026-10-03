import fs from 'node:fs';
import path from 'node:path';
import { encodeChunk, decodeChunk } from './chunk.js';
import { QcError, E } from './errors.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function normAt(at) {
  if (at === undefined || at === null) return new Date().toISOString();
  if (typeof at === 'number' && Number.isFinite(at)) return new Date(at).toISOString();
  if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return new Date(at).toISOString();
  throw new QcError(E.INVALID, `invalid timestamp: ${at}`);
}

function toMs(at) {
  return Date.parse(at);
}

// Write tmp file, fsync, then rename into place (atomic on POSIX).
function writeFileAtomic(finalPath, data) {
  const tmp = finalPath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, finalPath);
}

function judge(tolerance, value) {
  return value >= tolerance.min && value <= tolerance.max ? 'pass' : 'fail';
}

function chunkFileName(index) {
  return `chunks/${String(index + 1).padStart(6, '0')}.chk`;
}

export class Store {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  _checkId(batchId) {
    if (typeof batchId !== 'string' || !ID_RE.test(batchId)) {
      throw new QcError(E.INVALID, `invalid batch id: ${batchId}`);
    }
  }

  _dir(batchId) {
    return path.join(this.root, batchId);
  }

  _manifestPath(batchId) {
    return path.join(this._dir(batchId), 'manifest.json');
  }

  _loadManifest(batchId) {
    this._checkId(batchId);
    let raw;
    try {
      raw = fs.readFileSync(this._manifestPath(batchId), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new QcError(E.NOT_FOUND, `unknown batch: ${batchId}`);
      throw err;
    }
    return JSON.parse(raw);
  }

  initBatch({ batchId, baseline, min, max, unit = '', at, chunkSize = 16 }) {
    this._checkId(batchId);
    for (const [name, v] of Object.entries({ baseline, min, max })) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new QcError(E.INVALID, `${name} must be a finite number`);
      }
    }
    if (min > max) throw new QcError(E.INVALID, 'min must be <= max');
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new QcError(E.INVALID, 'chunkSize must be a positive integer');
    }
    if (fs.existsSync(this._manifestPath(batchId))) {
      throw new QcError(E.EXISTS, `batch already exists: ${batchId}`);
    }
    fs.mkdirSync(path.join(this._dir(batchId), 'chunks'), { recursive: true });
    const manifest = {
      version: 1,
      batchId,
      baseline,
      tolerance: { min, max },
      unit,
      chunkSize,
      createdAt: normAt(at),
      chunks: [],
      nextSeq: 0,
      lastValue: 0,
    };
    this._appendRecords(manifest, [{ type: 'baseline', value: baseline, at: manifest.createdAt }]);
    return this.decode(batchId);
  }

  appendMeasure(batchId, { value, at }) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new QcError(E.INVALID, 'value must be a finite number');
    }
    const manifest = this._loadManifest(batchId);
    this._appendRecords(manifest, [{ type: 'measure', value, at: normAt(at) }]);
    return this.decode(batchId);
  }

  appendCompensation(batchId, { refs, value, reason, at }) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new QcError(E.INVALID, 'value must be a finite number');
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new QcError(E.INVALID, 'compensation reason is required');
    }
    const manifest = this._loadManifest(batchId);
    if (!Number.isInteger(refs) || refs < 1 || refs >= manifest.nextSeq) {
      throw new QcError(
        E.REFERENCE,
        `compensation references unknown measurement seq ${refs}`,
        { batchId, refs },
      );
    }
    this._appendRecords(manifest, [
      { type: 'compensate', refs, value, reason, at: normAt(at) },
    ]);
    return this.decode(batchId);
  }

  // Append records to a batch. Data chunks are written via tmp+rename first;
  // the manifest rename is the atomic commit point. With commit:false the new
  // chunk files exist on disk but are unreferenced, hence invisible to readers
  // (simulates a crash before the manifest rename).
  _appendRecords(manifest, inputs, { commit = true } = {}) {
    const m = structuredClone(manifest);
    let prev = m.lastValue;
    const records = inputs.map((input) => {
      const rec = { ...input, seq: m.nextSeq };
      m.nextSeq += 1;
      rec.delta = input.type === 'baseline' ? 0 : input.value - prev;
      if (rec.type === 'baseline') delete rec.delta;
      prev = input.value;
      return rec;
    });
    m.lastValue = prev;

    const writes = []; // { index, records }
    let rest = records;
    if (m.chunks.length > 0 && rest.length > 0) {
      const last = m.chunks[m.chunks.length - 1];
      const space = m.chunkSize - last.records;
      if (space > 0) {
        const fill = rest.slice(0, space);
        rest = rest.slice(space);
        // Manifest is the source of truth: a chunk file may contain extra
        // uncommitted records (crash before manifest rename); ignore them.
        const existing = decodeChunk(
          fs.readFileSync(path.join(this._dir(m.batchId), last.file)),
          last.index,
        ).slice(0, last.records);
        const merged = existing.concat(fill);
        writes.push({ index: last.index, records: merged });
        m.chunks[m.chunks.length - 1] = {
          file: last.file,
          index: last.index,
          records: merged.length,
          seqFrom: merged[0].seq,
          seqTo: merged[merged.length - 1].seq,
        };
      }
    }
    while (rest.length > 0) {
      const slice = rest.slice(0, m.chunkSize);
      rest = rest.slice(m.chunkSize);
      const index = m.chunks.length;
      const file = chunkFileName(index);
      writes.push({ index, records: slice });
      m.chunks.push({
        file,
        index,
        records: slice.length,
        seqFrom: slice[0].seq,
        seqTo: slice[slice.length - 1].seq,
      });
    }

    for (const w of writes) {
      const finalPath = path.join(this._dir(m.batchId), m.chunks[w.index].file);
      const tmp = finalPath + '.tmp';
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, encodeChunk(w.index, w.records));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, finalPath);
    }

    if (commit) {
      writeFileAtomic(this._manifestPath(m.batchId), JSON.stringify(m, null, 2) + '\n');
    }
    return { manifest: m, records };
  }

  // Incremental delta decoder. Returns raw history, current effective value,
  // pass/fail judgment and correction reason. Out-of-tolerance values are a
  // judgment result, never a file error. asOfSeq replays history up to a seq
  // so past judgments can be reproduced for audit.
  decode(batchId, { asOfSeq } = {}) {
    const m = this._loadManifest(batchId);
    const limit = asOfSeq === undefined ? Infinity : asOfSeq;
    const history = [];
    let prev = 0;
    for (const meta of m.chunks) {
      if (meta.seqFrom > limit) break;
      const buf = fs.readFileSync(path.join(this._dir(m.batchId), meta.file));
      let records;
      try {
        records = decodeChunk(buf, meta.index);
      } catch (err) {
        if (err instanceof QcError && err.code === E.CRC) {
          err.details = { ...(err.details || {}), batchId, chunk: meta.file, recovered: history.length };
          err.partial = buildView(m, history);
        }
        throw err;
      }
      // Only records referenced by the manifest are visible; any tail beyond
      // meta.records is an uncommitted remnant of a crashed write.
      for (const rec of records.slice(0, meta.records)) {
        if (rec.seq > limit) break;
        const rawValue = rec.type === 'baseline' ? rec.value : prev + rec.delta;
        if (rec.type === 'compensate') {
          const target = history.find((h) => h.seq === rec.refs);
          if (!target || target.type === 'baseline') {
            throw new QcError(
              E.REFERENCE,
              `compensation seq ${rec.seq} references unknown measurement seq ${rec.refs}`,
              { batchId, refs: rec.refs },
            );
          }
        }
        history.push({ ...rec, rawValue });
        prev = rawValue;
      }
    }
    return buildView(m, history);
  }

  // Time-ordered index for one batch: locate records by measurement time.
  index(batchId) {
    const view = this.decode(batchId);
    return view.history
      .map((h) => ({ at: h.at, ms: toMs(h.at), seq: h.seq }))
      .sort((a, b) => a.ms - b.ms || a.seq - b.seq);
  }

  // Latest record at or before the given time, per the batch/time index.
  findAt(batchId, at) {
    const ms = toMs(normAt(at));
    const idx = this.index(batchId);
    let lo = 0;
    let hi = idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (idx[mid].ms <= ms) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return null;
    const seq = idx[lo - 1].seq;
    const view = this.decode(batchId);
    return view.history.find((h) => h.seq === seq);
  }

  listBatches() {
    const out = [];
    for (const name of fs.readdirSync(this.root).sort()) {
      const mp = path.join(this.root, name, 'manifest.json');
      if (!fs.existsSync(mp)) continue;
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      out.push({
        batchId: m.batchId,
        records: m.nextSeq,
        chunks: m.chunks.length,
        tolerance: m.tolerance,
        createdAt: m.createdAt,
      });
    }
    return out;
  }

  // Rescan the whole root (e.g. after restart). Corrupt batches are reported
  // with their error code; state before the damaged chunk stays recoverable.
  scan() {
    const out = [];
    for (const name of fs.readdirSync(this.root).sort()) {
      const mp = path.join(this.root, name, 'manifest.json');
      if (!fs.existsSync(mp)) continue;
      try {
        const view = this.decode(name);
        out.push({
          batchId: name,
          status: 'ok',
          records: view.history.length,
          effective: view.effective,
        });
      } catch (err) {
        if (err instanceof QcError) {
          out.push({
            batchId: name,
            status: 'error',
            error: err.code,
            recovered: err.partial ? err.partial.history.length : 0,
          });
        } else {
          throw err;
        }
      }
    }
    return out;
  }
}

function buildView(manifest, history) {
  const superseded = new Set();
  for (const h of history) {
    if (h.type === 'compensate') superseded.add(h.refs);
  }
  const entries = history.map((h) => {
    const entry = {
      seq: h.seq,
      type: h.type,
      at: h.at,
      value: h.rawValue,
      delta: h.type === 'baseline' ? 0 : h.delta,
      judgment: judge(manifest.tolerance, h.rawValue),
      superseded: superseded.has(h.seq),
    };
    if (h.type === 'compensate') {
      entry.refs = h.refs;
      entry.reason = h.reason;
    }
    return entry;
  });
  const last = entries[entries.length - 1] || null;
  return {
    batchId: manifest.batchId,
    unit: manifest.unit,
    baseline: manifest.baseline,
    tolerance: manifest.tolerance,
    history: entries,
    effective: last ? { seq: last.seq, value: last.value, judgment: last.judgment } : null,
    correctionReason: last && last.type === 'compensate' ? last.reason : null,
  };
}

export { normAt };
