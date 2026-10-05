import fs from 'node:fs';
import path from 'node:path';
import { readJson, atomicWriteJson, normalizeTokens, padNum } from './util.js';
import { Dictionary } from './dict.js';
import { encodePostings } from './index.js';

export class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function syncSleep(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

export class Archive {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.opts = opts;
    fs.mkdirSync(dir, { recursive: true });
    this.dict = new Dictionary(dir);
    this._load();
  }

  get manifestPath() { return path.join(this.dir, 'manifest.json'); }
  get activeFile() { return path.join(this.dir, 'active', 'events.jsonl'); }
  get frozenDir() { return path.join(this.dir, 'frozen'); }
  get tmpDir() { return path.join(this.dir, 'tmp'); }

  _load() {
    this.manifest = readJson(this.manifestPath, null) || {
      version: 1,
      nextSeq: 1,
      nextSegId: 1,
      dictVersion: 0,
      frozen: [],
      tombstones: [],
    };
    this._cleanup();
    this.activeEvents = this._readActive();
    this._dedupeActive();
  }

  // Remove staging dirs from interrupted merges and frozen segment dirs that
  // are not referenced by the committed manifest.
  _cleanup() {
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
    let entries = [];
    try {
      entries = fs.readdirSync(this.frozenDir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const live = new Set(this.manifest.frozen);
    for (const name of entries) {
      if (name.startsWith('.staging') || (name.startsWith('seg-') && !live.has(name))) {
        fs.rmSync(path.join(this.frozenDir, name), { recursive: true, force: true });
      }
    }
  }

  _readActive() {
    let lines;
    try {
      lines = fs.readFileSync(this.activeFile, 'utf8').split('\n').filter(Boolean);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return lines.map((l) => JSON.parse(l));
  }

  // A crash between manifest commit and active truncation during freeze can
  // leave already-frozen events in the active log; drop them by seq.
  _dedupeActive() {
    if (this.manifest.frozen.length === 0 || this.activeEvents.length === 0) return;
    let maxFrozenSeq = 0;
    for (const id of this.manifest.frozen) {
      const meta = readJson(path.join(this.frozenDir, id, 'meta.json'), null);
      if (meta) maxFrozenSeq = Math.max(maxFrozenSeq, meta.lastSeq);
    }
    const kept = this.activeEvents.filter((e) => e.seq > maxFrozenSeq);
    if (kept.length !== this.activeEvents.length) {
      this.activeEvents = kept;
      this._writeActive();
    }
  }

  _writeActive() {
    fs.mkdirSync(path.dirname(this.activeFile), { recursive: true });
    const body = this.activeEvents.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(this.activeFile, body ? body + '\n' : '');
  }

  _saveManifest() {
    atomicWriteJson(this.manifestPath, this.manifest);
  }

  tombstoneCutoff() {
    let cutoff = -Infinity;
    for (const t of this.manifest.tombstones) cutoff = Math.max(cutoff, t.cutoff);
    return cutoff;
  }

  append({ ts, device, tokens }) {
    if (!Number.isFinite(ts)) throw new ArchiveError('E_WINDOW', `invalid ts: ${ts}`);
    if (!device) throw new ArchiveError('E_WINDOW', 'device is required');
    const toks = Array.isArray(tokens) ? tokens.map((t) => normalizeTokens(t)).flat() : normalizeTokens(tokens);
    if (toks.length === 0) throw new ArchiveError('E_WINDOW', 'event must contain at least one token');
    const seq = this.manifest.nextSeq++;
    const event = { id: `e${padNum(seq, 8)}`, seq, ts, device, tokens: toks };
    this.activeEvents.push(event);
    fs.mkdirSync(path.dirname(this.activeFile), { recursive: true });
    fs.appendFileSync(this.activeFile, JSON.stringify(event) + '\n');
    this._saveManifest();
    return event;
  }

  _lastFrozenMaxTs() {
    if (this.manifest.frozen.length === 0) return -Infinity;
    const last = this.manifest.frozen[this.manifest.frozen.length - 1];
    const meta = readJson(path.join(this.frozenDir, last, 'meta.json'), null);
    return meta ? meta.maxTs : -Infinity;
  }

  _buildSegment(segId, events) {
    const sorted = [...events].sort((a, b) => a.ts - b.ts || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0) || a.seq - b.seq);
    const allTokens = [];
    for (const e of sorted) allTokens.push(...e.tokens);
    const { version, ids } = this.dict.encode(allTokens);
    const counters = new Map();
    const stored = sorted.map((e) => {
      const start = counters.get(e.device) || 0;
      counters.set(e.device, start + e.tokens.length);
      return { id: e.id, seq: e.seq, ts: e.ts, device: e.device, start, toks: e.tokens.map((t) => ids.get(t)) };
    });
    // frozen-layer index: token -> device -> block-compressed postings + skip list
    const postings = new Map();
    for (const e of stored) {
      for (let i = 0; i < e.toks.length; i++) {
        const tokId = e.toks[i];
        let perDevice = postings.get(tokId);
        if (!perDevice) { perDevice = new Map(); postings.set(tokId, perDevice); }
        let list = perDevice.get(e.device);
        if (!list) { list = []; perDevice.set(e.device, list); }
        list.push(e.start + i);
      }
    }
    const dictTokens = this.dict.load(version).tokens;
    const indexTokens = {};
    for (const [tokId, perDevice] of postings) {
      const devices = {};
      for (const [dev, list] of perDevice) devices[dev] = encodePostings(list);
      indexTokens[dictTokens[tokId]] = { devices };
    }
    const devices = {};
    for (const [dev, count] of counters) devices[dev] = count;
    const meta = {
      id: segId,
      firstSeq: sorted[0].seq,
      lastSeq: sorted[sorted.length - 1].seq,
      minTs: sorted[0].ts,
      maxTs: sorted[sorted.length - 1].ts,
      eventCount: sorted.length,
      dictVersion: version,
      devices,
      createdAt: new Date().toISOString(),
    };
    return { meta, events: stored, index: { tokens: indexTokens } };
  }

  _writeSegmentDir(targetDir, seg) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'events.json'), JSON.stringify(seg.events));
    fs.writeFileSync(path.join(targetDir, 'index.json'), JSON.stringify(seg.index));
    atomicWriteJson(path.join(targetDir, 'meta.json'), seg.meta);
  }

  freeze() {
    if (this.activeEvents.length === 0) {
      throw new ArchiveError('E_WINDOW', 'freeze window is empty: no active events');
    }
    const minTs = Math.min(...this.activeEvents.map((e) => e.ts));
    const frozenMax = this._lastFrozenMaxTs();
    if (minTs < frozenMax) {
      throw new ArchiveError('E_WINDOW', `active events (minTs=${minTs}) overlap frozen window (maxTs=${frozenMax})`);
    }
    const segId = `seg-${padNum(this.manifest.nextSegId, 6)}`;
    const seg = this._buildSegment(segId, this.activeEvents);
    const staging = path.join(this.tmpDir, `freeze-${process.pid}`);
    this._writeSegmentDir(staging, seg);
    fs.mkdirSync(this.frozenDir, { recursive: true });
    fs.renameSync(staging, path.join(this.frozenDir, segId));
    this.manifest.frozen.push(segId);
    this.manifest.nextSegId++;
    this.manifest.dictVersion = this.dict.latestVersion();
    this._saveManifest();
    this.activeEvents = [];
    this._writeActive();
    return seg.meta;
  }

  loadSegment(segId) {
    const dir = path.join(this.frozenDir, segId);
    const meta = readJson(path.join(dir, 'meta.json'), null);
    if (!meta) throw new ArchiveError('E_WINDOW', `unknown segment ${segId}`);
    const events = readJson(path.join(dir, 'events.json'), []);
    const index = readJson(path.join(dir, 'index.json'), { tokens: {} });
    const decoded = events.map((e) => ({ ...e, tokens: this.dict.decode(meta.dictVersion, e.toks) }));
    return { meta, events: decoded, index };
  }

  merge(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      throw new ArchiveError('E_WINDOW', `invalid merge window [${from}, ${to}]`);
    }
    const metas = this.manifest.frozen.map((id) => readJson(path.join(this.frozenDir, id, 'meta.json'), null));
    const selected = [];
    metas.forEach((meta, i) => {
      if (meta && meta.minTs >= from && meta.maxTs <= to) selected.push({ id: this.manifest.frozen[i], meta });
    });
    if (selected.length < 2) {
      throw new ArchiveError('E_MERGE', `merge window [${from}, ${to}] covers ${selected.length} segment(s), need at least 2`);
    }
    const cutoff = this.tombstoneCutoff();
    const events = [];
    for (const { id } of selected) {
      const seg = this.loadSegment(id);
      for (const e of seg.events) {
        if (e.ts >= cutoff) events.push({ id: e.id, seq: e.seq, ts: e.ts, device: e.device, tokens: e.tokens });
      }
    }
    const newId = `seg-${padNum(this.manifest.nextSegId, 6)}`;
    const staging = path.join(this.tmpDir, `merge-${process.pid}`);
    let newMeta = null;
    if (events.length > 0) {
      const seg = this._buildSegment(newId, events);
      newMeta = seg.meta;
      this._writeSegmentDir(staging, seg);
      fs.mkdirSync(this.frozenDir, { recursive: true });
      fs.renameSync(staging, path.join(this.frozenDir, `.staging-${newId}`));
    }
    // Test hook: pause after the new segment is fully staged but before the
    // atomic manifest commit, so a kill here must leave the old window live.
    const delay = this.opts.mergeDelayMs ?? Number(process.env.ARCHIVE_MERGE_DELAY_MS || 0);
    if (delay) syncSleep(delay);
    if (newMeta) {
      fs.renameSync(path.join(this.frozenDir, `.staging-${newId}`), path.join(this.frozenDir, newId));
      this.manifest.nextSegId++;
    }
    const drop = new Set(selected.map((s) => s.id));
    const nextFrozen = [];
    for (const id of this.manifest.frozen) {
      if (!drop.has(id)) nextFrozen.push(id);
      if (id === selected[0].id && newMeta) nextFrozen.push(newId);
    }
    this.manifest.frozen = nextFrozen;
    this.manifest.dictVersion = this.dict.latestVersion();
    this._saveManifest(); // atomic commit point
    for (const { id } of selected) {
      fs.rmSync(path.join(this.frozenDir, id), { recursive: true, force: true });
    }
    return { merged: selected.map((s) => s.id), into: newMeta ? newId : null, meta: newMeta };
  }

  retain(before) {
    if (!Number.isFinite(before)) {
      throw new ArchiveError('E_RETAIN', `invalid retention cutoff: ${before}`);
    }
    const cutoff = this.tombstoneCutoff();
    if (before <= cutoff) {
      throw new ArchiveError('E_RETAIN', `cutoff ${before} already covered by tombstone cutoff ${cutoff}`);
    }
    this.manifest.tombstones.push({ cutoff: before, at: new Date().toISOString() });
    this._saveManifest();
    const kept = this.activeEvents.filter((e) => e.ts >= before);
    if (kept.length !== this.activeEvents.length) {
      this.activeEvents = kept;
      this._writeActive();
    }
    return { cutoff: before };
  }

  stats() {
    const cutoff = this.tombstoneCutoff();
    const frozen = this.manifest.frozen.map((id) => readJson(path.join(this.frozenDir, id, 'meta.json'), null)).filter(Boolean);
    const liveFrozenEvents = frozen.reduce((sum, m) => sum + m.eventCount, 0);
    const activeLive = this.activeEvents.filter((e) => e.ts >= cutoff).length;
    const dictVersion = this.dict.latestVersion();
    const dictSize = dictVersion > 0 ? this.dict.load(dictVersion).tokens.length : 0;
    return {
      segments: {
        active: { events: this.activeEvents.length, live: activeLive },
        frozen: frozen.map((m) => ({ id: m.id, minTs: m.minTs, maxTs: m.maxTs, events: m.eventCount, dictVersion: m.dictVersion })),
      },
      tombstones: this.manifest.tombstones,
      tombstoneCutoff: cutoff === -Infinity ? null : cutoff,
      totalEvents: liveFrozenEvents + this.activeEvents.length,
      dictVersion,
      dictSize,
    };
  }
}
