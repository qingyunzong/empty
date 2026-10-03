import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encodeSegment, decodeSegment } from './segment.js';
import { AlertError } from './errors.js';

export { AlertError };

export const SEVERITY_RANK = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
  debug: 4,
};

export function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? 50;
}

export function compareAlerts(a, b) {
  const ra = severityRank(a.severity);
  const rb = severityRank(b.severity);
  if (ra !== rb) return ra - rb;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  return a.seq - b.seq;
}

const DEFAULTS = {
  chunkSize: 4096,
  segmentChunks: 16,
  maxSegments: 64,
};

function segFileName(id) {
  return `seg-${String(id).padStart(6, '0')}.dat`;
}

async function fsyncDir(dir) {
  try {
    const fh = await fs.open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // best effort (some platforms cannot fsync directories)
  }
}

async function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
  await fsyncDir(path.dirname(file));
}

export class AlertStore {
  static async open(dir, opts = {}) {
    const store = new AlertStore(dir, opts);
    await store._init();
    return store;
  }

  constructor(dir, opts = {}) {
    this.dir = dir;
    this.segmentsDir = path.join(dir, 'segments');
    this.manifestPath = path.join(dir, 'manifest.json');
    this.indexPath = path.join(dir, 'index.json');
    this.opts = { ...DEFAULTS, ...opts };
    this.hooks = opts.hooks ?? {};
    this.manifest = { version: 1, nextSegmentId: 1, segments: [] };
    this.segmentData = new Map(); // segmentId -> [{offset, record}]
    this.seqIndex = new Map(); // device -> Set(seq)
    this.active = null; // {id, records: []}
  }

  async _init() {
    await fs.mkdir(this.segmentsDir, { recursive: true });
    try {
      this.manifest = JSON.parse(await fs.readFile(this.manifestPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // Remove stale temp files and orphan segments not referenced by the manifest
    // (a crash before the manifest rename leaves the new segment as an orphan;
    // the old manifest stays the source of truth).
    const referenced = new Set(this.manifest.segments.map((s) => s.file));
    for (const name of await fs.readdir(this.segmentsDir)) {
      if (name.endsWith('.tmp') || (name.endsWith('.dat') && !referenced.has(name))) {
        await fs.rm(path.join(this.segmentsDir, name), { force: true });
      }
    }
    await fs.rm(`${this.manifestPath}.tmp`, { force: true });

    for (const entry of this.manifest.segments) {
      const decoded = await this._readSegment(entry);
      this.segmentData.set(entry.id, decoded.records);
      for (const { record } of decoded.records) {
        let set = this.seqIndex.get(record.device);
        if (!set) this.seqIndex.set(record.device, (set = new Set()));
        set.add(record.seq);
      }
    }
    // The newest segment stays active if it still has spare capacity.
    const last = this.manifest.segments[this.manifest.segments.length - 1];
    if (last) {
      const records = this.segmentData.get(last.id).map((r) => r.record);
      try {
        encodeSegment({ segmentId: last.id, ...this._segParams(), records });
        this.active = { id: last.id, records };
      } catch (err) {
        if (err.code !== 'E_SEGMENT_FULL') throw err;
        this.active = null;
      }
    }
  }

  _segParams() {
    return { chunkSize: this.opts.chunkSize, chunkCount: this.opts.segmentChunks };
  }

  async _readSegment(entry) {
    const buf = await fs.readFile(path.join(this.segmentsDir, entry.file));
    return decodeSegment(buf);
  }

  _newActive() {
    const id = this.manifest.nextSegmentId++;
    this.active = { id, records: [] };
  }

  _encodeActive() {
    return encodeSegment({
      segmentId: this.active.id,
      ...this._segParams(),
      records: this.active.records,
    });
  }

  async _persistActive() {
    const { fileBuffer, offsets } = this._encodeActive();
    const file = segFileName(this.active.id);
    await writeFileAtomic(path.join(this.segmentsDir, file), fileBuffer);
    this.segmentData.set(
      this.active.id,
      this.active.records.map((record, i) => ({ offset: offsets[i], record })),
    );
    return file;
  }

  async append(record) {
    const { device, seq, severity, message } = record ?? {};
    if (typeof device !== 'string' || device.length === 0) {
      throw new AlertError('E_INVALID', 'record.device must be a non-empty string');
    }
    if (!Number.isInteger(seq) || seq < 0) {
      throw new AlertError('E_INVALID', 'record.seq must be a non-negative integer');
    }
    const rec = {
      device,
      seq,
      severity: severity ?? 'info',
      message: message ?? '',
    };

    // Idempotent dedup: a sequence number already stored for this device is ignored.
    if (this.seqIndex.get(device)?.has(seq)) {
      return { status: 'deduped', device, seq };
    }

    if (!this.active) this._newActive();
    this.active.records.push(rec);
    let file;
    try {
      file = await this._persistActive();
    } catch (err) {
      if (err.code !== 'E_SEGMENT_FULL') {
        this.active.records.pop();
        throw err;
      }
      // Active segment is full (and already durable without this record):
      // roll over to a fresh segment.
      this.active.records.pop();
      this._newActive();
      this.active.records.push(rec);
      file = await this._persistActive();
    }

    // Ring commit point: the new segment file is durable; only now publish it
    // (and evict the oldest segments) via an atomic manifest rename.
    if (!this.manifest.segments.some((s) => s.id === this.active.id)) {
      this.manifest.segments.push({ id: this.active.id, file });
      const evicted = [];
      while (this.manifest.segments.length > this.opts.maxSegments) {
        evicted.push(this.manifest.segments.shift());
      }
      await this._commitManifest(evicted);
    }

    let set = this.seqIndex.get(device);
    if (!set) this.seqIndex.set(device, (set = new Set()));
    set.add(seq);
    return { status: 'appended', device, seq };
  }

  async appendBatch(records) {
    let appended = 0;
    let deduped = 0;
    for (const record of records) {
      const r = await this.append(record);
      if (r.status === 'appended') appended += 1;
      else deduped += 1;
    }
    return { appended, deduped };
  }

  async _commitManifest(evicted) {
    const body = JSON.stringify(this.manifest, null, 2);
    const tmp = `${this.manifestPath}.tmp`;
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // Crash-simulation / test hook: throwing here leaves the old manifest
    // untouched, so previously readable segments remain readable.
    await this.hooks.beforeManifestRename?.({ manifest: this.manifest, evicted });
    await fs.rename(tmp, this.manifestPath);
    await fsyncDir(this.dir);
    for (const entry of evicted) {
      this.segmentData.delete(entry.id);
      await fs.rm(path.join(this.segmentsDir, entry.file), { force: true });
    }
  }

  // Incremental replay. cursor = {device: lastContiguousSeq} previously acknowledged.
  // Returns the contiguous prefix per device; a sequence hole yields E_GAP in
  // result.error while the already-contiguous prefix is still delivered.
  async replay(cursor = {}) {
    const perDevice = new Map();
    for (const entry of this.manifest.segments) {
      const decoded = await this._readSegment(entry); // E_CRC surfaces here
      for (const { record } of decoded.records) {
        let list = perDevice.get(record.device);
        if (!list) perDevice.set(record.device, (list = []));
        list.push(record);
      }
    }

    const alerts = [];
    const gaps = [];
    const newCursor = { ...cursor };
    for (const device of [...perDevice.keys()].sort()) {
      const recs = perDevice.get(device).sort((a, b) => a.seq - b.seq);
      const start = cursor[device] ?? recs[0].seq - 1;
      let expected = start + 1;
      let last = cursor[device];
      for (const rec of recs) {
        if (rec.seq <= start) continue; // already acknowledged
        if (rec.seq !== expected) {
          gaps.push({ device, expected, found: rec.seq });
          break; // never skip a hole and pretend completeness
        }
        alerts.push(rec);
        last = rec.seq;
        expected += 1;
      }
      if (last !== undefined) newCursor[device] = last;
    }

    alerts.sort(compareAlerts);
    const result = { alerts, cursor: newCursor, gaps };
    if (gaps.length > 0) {
      result.error = new AlertError('E_GAP', 'sequence gap detected during replay', gaps);
    }
    return result;
  }

  async verify() {
    let records = 0;
    for (const entry of this.manifest.segments) {
      const decoded = await this._readSegment(entry);
      records += decoded.records.length;
    }
    return { segments: this.manifest.segments.length, records };
  }

  // Index: per device min/max sequence and the file offset of the device's
  // first record in each segment.
  buildIndex() {
    const devices = {};
    for (const entry of this.manifest.segments) {
      const rows = this.segmentData.get(entry.id) ?? [];
      for (const { offset, record } of rows) {
        const d = (devices[record.device] ??= {
          minSeq: Infinity,
          maxSeq: -Infinity,
          segments: new Map(),
        });
        d.minSeq = Math.min(d.minSeq, record.seq);
        d.maxSeq = Math.max(d.maxSeq, record.seq);
        let seg = d.segments.get(entry.id);
        if (!seg) {
          seg = { segment: entry.id, file: entry.file, offset, minSeq: record.seq, maxSeq: record.seq };
          d.segments.set(entry.id, seg);
        }
        seg.offset = Math.min(seg.offset, offset);
        seg.minSeq = Math.min(seg.minSeq, record.seq);
        seg.maxSeq = Math.max(seg.maxSeq, record.seq);
      }
    }
    const out = {};
    for (const [device, d] of Object.entries(devices)) {
      out[device] = {
        minSeq: d.minSeq,
        maxSeq: d.maxSeq,
        segments: [...d.segments.values()],
      };
    }
    return { version: 1, devices: out };
  }

  async close() {
    await writeFileAtomic(this.indexPath, JSON.stringify(this.buildIndex(), null, 2));
  }
}
