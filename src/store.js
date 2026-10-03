import fs from 'node:fs';
import path from 'node:path';
import {
  SegmentEncoder, readSegment, segmentHeaderBuffer,
  STATE_ACTIVE, STATE_FROZEN, STATE_OFFSET,
} from './segment.js';
import { ioError, seqError, rangeError } from './errors.js';

const MANIFEST = 'manifest.json';
const MANIFEST_TMP = 'manifest.json.tmp';
const MANIFEST_BAK = 'manifest.bak';
const AUDIT = 'audit.log';

const emptyManifest = () => ({ version: 1, nextSegId: 1, segments: [], tombstones: [] });
const eventHash = (e) => `${e.seq}|${e.ts}|${e.code}|${e.device}`;

export class Store {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.hooks = opts.hooks || {};
    this.manifest = null;
    this.seqIndex = new Map(); // seq -> payload hash, for idempotent ingest
    this.activePath = null;
    this.activeEncoder = null;
  }

  static open(dir, opts = {}) {
    const store = new Store(dir, opts);
    store._load(!!opts.create);
    return store;
  }

  segmentsDir() { return path.join(this.dir, 'segments'); }

  _fsyncDir() {
    try {
      const fd = fs.openSync(this.dir, 'r');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch { /* directory fsync unsupported; best effort */ }
  }

  _load(create) {
    if (!fs.existsSync(this.dir)) {
      if (create) fs.mkdirSync(this.dir, { recursive: true });
      else throw ioError(`data dir not found: ${this.dir}`);
    }
    const mpath = path.join(this.dir, MANIFEST);
    if (fs.existsSync(mpath)) {
      try {
        this.manifest = JSON.parse(fs.readFileSync(mpath, 'utf8'));
      } catch {
        throw ioError('manifest corrupt; run recover');
      }
    } else if (create) {
      this.manifest = emptyManifest();
      this._saveManifest();
    } else {
      throw ioError('manifest not found; run ingest or recover first');
    }
    fs.mkdirSync(this.segmentsDir(), { recursive: true });

    // Rebuild in-memory seq index and the active segment's encoder state.
    for (const seg of this.manifest.segments) {
      const p = path.join(this.dir, seg.file);
      if (!fs.existsSync(p)) throw ioError(`segment missing: ${seg.file}; run recover`);
      const r = readSegment(p); // tolerant: ignores a torn tail
      for (const e of r.events) {
        this.seqIndex.set(e.seq, eventHash({
          seq: e.seq, ts: e.ts, code: r.codes[e.codeIdx], device: r.devices[e.deviceIdx],
        }));
      }
      if (seg.state === 'active') {
        this.activePath = p;
        this.activeEncoder = new SegmentEncoder();
        r.codes.forEach((c, i) => this.activeEncoder.codes.set(c, i));
        r.devices.forEach((d, i) => this.activeEncoder.devices.set(d, i));
        if (r.events.length > 0) {
          this.activeEncoder.lastTs = r.events[r.events.length - 1].ts;
          this.activeEncoder.count = r.events.length;
        }
      }
    }
  }

  _saveManifest() {
    const data = JSON.stringify(this.manifest, null, 1);
    const tmp = path.join(this.dir, MANIFEST_TMP);
    fs.writeFileSync(tmp, data);
    const fd = fs.openSync(tmp, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    this.hooks.beforeManifestRename?.({ tmp });
    fs.renameSync(tmp, path.join(this.dir, MANIFEST)); // atomic swap
    fs.writeFileSync(path.join(this.dir, MANIFEST_BAK), data); // recovery fallback
    this._fsyncDir();
  }

  _ensureActiveSegment() {
    if (this.activePath) return;
    const id = `seg-${String(this.manifest.nextSegId++).padStart(6, '0')}`;
    const rel = `segments/${id}.seg`;
    const p = path.join(this.dir, rel);
    fs.writeFileSync(p, segmentHeaderBuffer(id, STATE_ACTIVE));
    const fd = fs.openSync(p, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    this.manifest.segments.push({ id, file: rel, state: 'active' });
    this._saveManifest();
    this.activePath = p;
    this.activeEncoder = new SegmentEncoder();
  }

  ingest(events) {
    if (!Array.isArray(events) || events.length === 0) {
      throw rangeError('events must be a non-empty array');
    }
    for (const e of events) {
      if (!Number.isSafeInteger(e.seq) || e.seq < 0) throw seqError(`invalid seq: ${e.seq}`);
      if (!Number.isSafeInteger(e.ts) || e.ts < 0) throw rangeError(`invalid ts: ${e.ts}`);
      if (typeof e.code !== 'string' || !e.code) throw rangeError('code must be a non-empty string');
      if (typeof e.device !== 'string' || !e.device) throw rangeError('device must be a non-empty string');
    }
    this._ensureActiveSegment();

    const buffers = [];
    const pending = [];
    let deduped = 0;
    for (const e of events) {
      const h = eventHash(e);
      const existing = this.seqIndex.get(e.seq);
      if (existing !== undefined) {
        if (existing === h) { deduped++; continue; } // idempotent re-ingest
        throw seqError(`seq ${e.seq} already exists with a different payload`);
      }
      buffers.push(this.activeEncoder.encodeEvent(e));
      pending.push([e.seq, h]);
      this.seqIndex.set(e.seq, h); // dedup within the same batch too
    }

    if (buffers.length > 0) {
      const fd = fs.openSync(this.activePath, 'a');
      try {
        for (const b of buffers) fs.writeSync(fd, b);
        // Fault-injection point 1: appended but not yet fsynced.
        this.hooks.afterAppendBeforeFsync?.({ path: this.activePath, fd });
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    return { ingested: pending.length, deduped };
  }

  freeze() {
    const seg = this.manifest.segments.find((s) => s.state === 'active');
    if (!seg) return { frozen: false };
    const p = path.join(this.dir, seg.file);
    const fd = fs.openSync(p, 'r+');
    fs.writeSync(fd, Buffer.from([STATE_FROZEN]), 0, 1, STATE_OFFSET);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    seg.state = 'frozen';
    this._saveManifest();
    this.activePath = null;
    this.activeEncoder = null;
    return { frozen: true, segment: seg.id };
  }

  // Logical delete: only appends a tombstone; physical removal happens in compact().
  deleteCode(code) {
    if (typeof code !== 'string' || !code) throw rangeError('code must be a non-empty string');
    if (!this.manifest.tombstones.some((t) => t.code === code)) {
      this.manifest.tombstones.push({ code, at: Date.now() });
      this._saveManifest();
    }
    return { tombstoned: code };
  }

  compact() {
    const frozen = this.manifest.segments.filter((s) => s.state === 'frozen');
    const tombstoned = new Set(this.manifest.tombstones.map((t) => t.code));
    if (frozen.length === 0) return { merged: false, reason: 'no frozen segments' };
    if (frozen.length === 1 && tombstoned.size === 0) return { merged: false, reason: 'nothing to merge' };

    const kept = [];
    let scanned = 0;
    for (const seg of frozen) {
      const r = readSegment(path.join(this.dir, seg.file));
      for (const e of r.events) {
        scanned++;
        const code = r.codes[e.codeIdx];
        if (tombstoned.has(code)) continue; // physical tombstone purge
        kept.push({ seq: e.seq, ts: e.ts, code, device: r.devices[e.deviceIdx] });
      }
    }
    kept.sort((a, b) => a.seq - b.seq);

    const id = `seg-${String(this.manifest.nextSegId++).padStart(6, '0')}`;
    const rel = `segments/${id}.seg`;
    const tmpPath = path.join(this.dir, `segments/${id}.seg.tmp`);
    const enc = new SegmentEncoder();
    const fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, segmentHeaderBuffer(id, STATE_FROZEN));
    for (const e of kept) fs.writeSync(fd, enc.encodeEvent(e));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmpPath, path.join(this.dir, rel));
    this._fsyncDir();

    // Fault-injection point 3: merged segment durable, manifest not yet swapped.
    this.hooks.beforeCompactManifestSwap?.({ mergedFile: rel, replaced: frozen.map((f) => f.file) });

    this.manifest.segments = this.manifest.segments.filter((s) => s.state !== 'frozen');
    this.manifest.segments.push({ id, file: rel, state: 'frozen' });
    this.manifest.tombstones = [];
    this._saveManifest();
    for (const seg of frozen) fs.unlinkSync(path.join(this.dir, seg.file));
    this._fsyncDir();
    return { merged: true, segmentsBefore: frozen.length, events: kept.length, purged: scanned - kept.length };
  }

  loadEvents() {
    const tombstoned = new Set(this.manifest.tombstones.map((t) => t.code));
    const bySeq = new Map();
    for (const seg of this.manifest.segments) {
      const r = readSegment(path.join(this.dir, seg.file));
      for (const e of r.events) {
        const code = r.codes[e.codeIdx];
        if (tombstoned.has(code)) continue;
        if (bySeq.has(e.seq)) continue;
        bySeq.set(e.seq, { seq: e.seq, ts: e.ts, code, device: r.devices[e.deviceIdx] });
      }
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  // Co-occurrence: device events within +/-window positions of each timeout-code event.
  queryCooccur({ device, timeoutCode, window = 5 }) {
    if (!Number.isSafeInteger(window) || window < 0 || window > 100000) {
      throw rangeError(`invalid window: ${window}`);
    }
    if (!device || !timeoutCode) throw rangeError('device and timeoutCode are required');
    const events = this.loadEvents();
    const hits = [];
    for (let i = 0; i < events.length; i++) {
      if (events[i].code !== timeoutCode) continue;
      const lo = Math.max(0, i - window);
      const hi = Math.min(events.length - 1, i + window);
      const matches = [];
      for (let j = lo; j <= hi; j++) {
        if (events[j].device === device) {
          matches.push({ pos: j, distance: j - i, ...events[j] });
        }
      }
      if (matches.length > 0) hits.push({ timeoutPos: i, timeoutSeq: events[i].seq, matches });
    }
    return { device, timeoutCode, window, events: events.length, hits };
  }

  // Phrase sequence: consecutive events whose codes match exactly, e.g. [ALARM, ACK, RESET].
  queryPhrase(codes) {
    if (!Array.isArray(codes) || codes.length === 0 || codes.some((c) => typeof c !== 'string' || !c)) {
      throw rangeError('phrase must be a non-empty array of codes');
    }
    const events = this.loadEvents();
    const hits = [];
    outer: for (let i = 0; i + codes.length <= events.length; i++) {
      for (let k = 0; k < codes.length; k++) {
        if (events[i + k].code !== codes[k]) continue outer;
      }
      hits.push({ pos: i, seqs: events.slice(i, i + codes.length).map((e) => e.seq) });
    }
    return { phrase: codes, events: events.length, hits };
  }

  // Crash recovery: reconcile manifest with on-disk segments, drop torn tails
  // and orphan files, and leave an audit trail. Deterministic for a given fs state.
  static recover(dir) {
    if (!fs.existsSync(dir)) throw ioError(`data dir not found: ${dir}`);
    const actions = [];

    const mtmp = path.join(dir, MANIFEST_TMP);
    if (fs.existsSync(mtmp)) {
      fs.unlinkSync(mtmp);
      actions.push({ action: 'tmp-removed', file: MANIFEST_TMP });
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    } catch {
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_BAK), 'utf8'));
        actions.push({ action: 'manifest-restored-from-bak' });
      } catch {
        manifest = emptyManifest();
        actions.push({ action: 'manifest-rebuilt-empty' });
      }
    }

    const segDir = path.join(dir, 'segments');
    const listed = new Set(manifest.segments.map((s) => s.file));
    if (fs.existsSync(segDir)) {
      for (const f of fs.readdirSync(segDir)) {
        const rel = `segments/${f}`;
        if (f.endsWith('.tmp')) {
          fs.unlinkSync(path.join(segDir, f));
          actions.push({ action: 'tmp-removed', file: rel });
        } else if (f.endsWith('.seg') && !listed.has(rel)) {
          fs.unlinkSync(path.join(segDir, f));
          actions.push({ action: 'orphan-removed', file: rel });
        }
      }
    }

    const kept = [];
    for (const seg of manifest.segments) {
      const p = path.join(dir, seg.file);
      if (!fs.existsSync(p)) {
        actions.push({ action: 'segment-missing', file: seg.file });
        continue;
      }
      const r = readSegment(p);
      if (r.truncatedBytes > 0) {
        fs.truncateSync(p, r.validEnd);
        actions.push({
          action: 'truncated-partial', file: seg.file, droppedBytes: r.truncatedBytes, reason: r.truncateReason,
        });
      }
      const fileState = r.state === STATE_FROZEN ? 'frozen' : 'active';
      if (fileState !== seg.state) {
        seg.state = fileState;
        actions.push({ action: 'state-synced', file: seg.file, state: fileState });
      }
      kept.push(seg);
    }
    manifest.segments = kept;

    const store = new Store(dir);
    store.manifest = manifest;
    store._saveManifest();
    actions.push({ action: 'manifest-rewritten', segments: kept.length });

    const auditPath = path.join(dir, AUDIT);
    for (const a of actions) {
      fs.appendFileSync(auditPath, `${JSON.stringify({ ts: new Date().toISOString(), op: 'recover', ...a })}\n`);
    }
    return { ok: true, actions };
  }
}
