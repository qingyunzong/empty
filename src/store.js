// Segment store for PLC events.
//
// Durability protocol per ingest:
//   1. append record frame to the active segment (writeSync)
//      [fault point: afterAppend]
//   2. fsync the segment file
//   3. atomically replace manifest.json (tmp + fsync + rename + dir fsync)
//      [fault point: midManifest]
// The manifest is the only source of truth: it records the committed byte
// length of every segment, so recover() can truncate uncommitted tails
// deterministically no matter what the crash left on disk.
//
// Compaction merges all frozen segments into a new file (dropping
// tombstoned codes physically), fsyncs it, then swaps the manifest.
//   [fault point: beforeMergeSwap] -> merged file is an orphan, recover()
//   deletes any segment file not referenced by the manifest.

import {
  openSync, closeSync, writeSync, fsyncSync, readFileSync, renameSync,
  existsSync, mkdirSync, readdirSync, unlinkSync, truncateSync, statSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { encodeHeader, encodeRecord, decodeSegment } from "./segment.js";

export class PLCError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PLCError";
    this.code = code; // E_IO | E_SEQ | E_RANGE
  }
}

export class FaultError extends Error {
  constructor(point) {
    super(`simulated crash at fault point: ${point}`);
    this.name = "FaultError";
    this.code = "E_FAULT";
    this.point = point;
  }
}

const MANIFEST = "manifest.json";
const MANIFEST_TMP = "manifest.json.tmp";
const AUDIT_LOG = "recover-audit.log";

function emptyState() {
  return { version: 1, gen: 0, nextSeq: 0, nextSegmentId: 1, dict: {}, tombstones: [], segments: [] };
}

function segFileName(id) {
  return `seg-${String(id).padStart(6, "0")}.plc`;
}

export class Store {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.fault = opts.fault ?? process.env.PLC_FAULT ?? null;
  }

  _fault(point) {
    if (this.fault === point) throw new FaultError(point);
  }

  _fsyncDir() {
    try {
      const fd = openSync(this.dir, "r");
      fsyncSync(fd);
      closeSync(fd);
    } catch {
      // directory fsync unsupported on some platforms; best effort
    }
  }

  _load() {
    const p = join(this.dir, MANIFEST);
    if (!existsSync(p)) return emptyState();
    let raw;
    try {
      raw = readFileSync(p, "utf8");
    } catch (e) {
      throw new PLCError("E_IO", `read manifest: ${e.message}`);
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new PLCError("E_IO", "manifest is corrupt and no consistent copy exists");
    }
  }

  _writeManifest(state) {
    const data = JSON.stringify(state);
    const tmp = join(this.dir, MANIFEST_TMP);
    if (this.fault === "midManifest") {
      // crash halfway through the manifest write: partial tmp, no rename
      writeSync(openSync(tmp, "w"), data.slice(0, Math.floor(data.length / 2)));
      throw new FaultError("midManifest");
    }
    const fd = openSync(tmp, "w");
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, join(this.dir, MANIFEST));
    this._fsyncDir();
  }

  _decodeFile(file) {
    let buf;
    try {
      buf = readFileSync(join(this.dir, file));
    } catch (e) {
      throw new PLCError("E_IO", `read segment ${file}: ${e.message}`);
    }
    return decodeSegment(buf);
  }

  ingest({ seq, ts, code }) {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new PLCError("E_RANGE", "seq must be a non-negative integer");
    if (!Number.isSafeInteger(ts) || ts < 0) throw new PLCError("E_RANGE", "ts must be a non-negative integer");
    if (typeof code !== "string" || code.length === 0) throw new PLCError("E_RANGE", "code must be a non-empty string");
    mkdirSync(this.dir, { recursive: true });
    const state = this._load();
    if (seq < state.nextSeq) return { dedup: true, seq, nextSeq: state.nextSeq };
    if (seq > state.nextSeq) {
      throw new PLCError("E_SEQ", `sequence gap: expected seq ${state.nextSeq}, got ${seq}`);
    }
    if (state.tombstones.includes(code)) throw new PLCError("E_RANGE", `code is deleted: ${code}`);
    let codeId = state.dict[code];
    if (codeId === undefined) {
      codeId = Object.keys(state.dict).length;
      state.dict[code] = codeId;
    }
    let seg = state.segments[state.segments.length - 1];
    if (!seg || seg.frozen) {
      seg = {
        id: state.nextSegmentId++, file: segFileName(state.nextSegmentId - 1), frozen: false,
        count: 0, minSeq: seq, maxSeq: seq, baseTs: ts, lastTs: ts, bytes: 0,
      };
      const header = encodeHeader(ts);
      const fd = openSync(join(this.dir, seg.file), "w");
      writeSync(fd, header);
      fsyncSync(fd);
      closeSync(fd);
      seg.bytes = header.length;
      state.segments.push(seg);
    }
    const frame = encodeRecord({ seq, tsDelta: ts - seg.lastTs, codeId });
    const fd = openSync(join(this.dir, seg.file), "a");
    writeSync(fd, frame);
    this._fault("afterAppend"); // crash: bytes maybe on disk, never fsynced, manifest untouched
    fsyncSync(fd);
    closeSync(fd);
    seg.count++;
    seg.maxSeq = seq;
    seg.lastTs = ts;
    seg.bytes += frame.length;
    state.nextSeq++;
    state.gen++;
    this._writeManifest(state);
    return { dedup: false, seq, codeId, segment: seg.id };
  }

  freeze() {
    const state = this._load();
    const seg = state.segments[state.segments.length - 1];
    if (!seg || seg.frozen) return { frozen: false, reason: "no-active-segment" };
    const fd = openSync(join(this.dir, seg.file), "r");
    fsyncSync(fd);
    closeSync(fd);
    seg.frozen = true;
    state.gen++;
    this._writeManifest(state);
    return { frozen: true, segment: seg.id, count: seg.count };
  }

  deleteCode(code) {
    const state = this._load();
    if (!(code in state.dict)) throw new PLCError("E_RANGE", `unknown code: ${code}`);
    if (!state.tombstones.includes(code)) state.tombstones.push(code);
    state.gen++;
    this._writeManifest(state);
    return { deleted: code, tombstoned: true };
  }

  compact() {
    const state = this._load();
    const frozen = state.segments.filter((s) => s.frozen);
    if (frozen.length === 0) return { merged: false, reason: "no-frozen-segments" };
    const tombIds = new Set(state.tombstones.map((c) => state.dict[c]).filter((x) => x !== undefined));
    const events = [];
    for (const seg of frozen) {
      const dec = this._decodeFile(seg.file);
      if (dec.error) throw new PLCError("E_IO", `frozen segment corrupt: ${seg.file}: ${dec.error}`);
      for (const r of dec.records.slice(0, seg.count)) {
        if (!tombIds.has(r.codeId)) events.push(r);
      }
    }
    const id = state.nextSegmentId++;
    const file = segFileName(id);
    const baseTs = events.length ? events[0].ts : 0;
    const parts = [encodeHeader(baseTs)];
    let prev = baseTs;
    for (const e of events) {
      parts.push(encodeRecord({ seq: e.seq, tsDelta: e.ts - prev, codeId: e.codeId }));
      prev = e.ts;
    }
    const buf = Buffer.concat(parts);
    const fd = openSync(join(this.dir, file), "w");
    writeSync(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
    this._fault("beforeMergeSwap"); // crash: merged file is an orphan, old segments intact
    const merged = {
      id, file, frozen: true, count: events.length,
      minSeq: events.length ? events[0].seq : null,
      maxSeq: events.length ? events[events.length - 1].seq : null,
      baseTs, lastTs: prev, bytes: buf.length,
    };
    const active = state.segments.filter((s) => !s.frozen);
    state.segments = [merged, ...active];
    const tombstonesCleared = active.length === 0;
    if (tombstonesCleared) state.tombstones = [];
    state.gen++;
    this._writeManifest(state);
    for (const seg of frozen) {
      try { unlinkSync(join(this.dir, seg.file)); } catch { /* already gone */ }
    }
    this._fsyncDir();
    return {
      merged: true, segment: id, count: events.length,
      removedSegments: frozen.map((s) => s.id), tombstonesCleared,
    };
  }

  recover() {
    mkdirSync(this.dir, { recursive: true });
    const audit = { removedTmp: false, orphans: [], truncated: null, discardedRecords: 0, manifestGen: null };
    const tmpPath = join(this.dir, MANIFEST_TMP);
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
      audit.removedTmp = true;
    }
    const state = this._load(); // missing manifest -> empty state; corrupt -> E_IO
    audit.manifestGen = state.gen;
    const known = new Set(state.segments.map((s) => s.file));
    for (const f of readdirSync(this.dir)) {
      if (/^seg-\d+\.plc$/.test(f) && !known.has(f)) {
        unlinkSync(join(this.dir, f));
        audit.orphans.push(f);
      }
    }
    for (const seg of state.segments) {
      const p = join(this.dir, seg.file);
      if (!existsSync(p)) throw new PLCError("E_IO", `segment missing: ${seg.file}`);
      const size = statSync(p).size;
      if (size < seg.bytes) throw new PLCError("E_IO", `segment shorter than committed length: ${seg.file}`);
      if (size > seg.bytes) {
        const dec = this._decodeFile(seg.file);
        truncateSync(p, seg.bytes);
        audit.truncated = { segment: seg.file, bytes: size - seg.bytes };
        audit.discardedRecords += Math.max(0, dec.records.length - seg.count);
      }
      if (!seg.frozen) {
        const dec = this._decodeFile(seg.file);
        if (dec.error || dec.records.length !== seg.count) {
          throw new PLCError("E_IO", `active segment inconsistent after truncation: ${seg.file}`);
        }
      }
    }
    this._fsyncDir();
    appendFileSync(join(this.dir, AUDIT_LOG), JSON.stringify({ at: new Date().toISOString(), ...audit }) + "\n");
    return audit;
  }

  _readAllEvents(state) {
    const idToCode = new Map(Object.entries(state.dict).map(([c, i]) => [i, c]));
    const tomb = new Set(state.tombstones);
    const out = [];
    for (const seg of state.segments) {
      const dec = this._decodeFile(seg.file);
      for (const r of dec.records.slice(0, seg.count)) {
        const code = idToCode.get(r.codeId);
        if (code === undefined) throw new PLCError("E_IO", `unknown codeId ${r.codeId} in ${seg.file}`);
        if (tomb.has(code)) continue;
        out.push({ seq: r.seq, ts: r.ts, code });
      }
    }
    return out;
  }

  queryCooccur({ device, timeout, window = 5 }) {
    if (!Number.isSafeInteger(window) || window < 0) throw new PLCError("E_RANGE", "window must be a non-negative integer");
    if (typeof device !== "string" || !device) throw new PLCError("E_RANGE", "device code required");
    if (typeof timeout !== "string" || !timeout) throw new PLCError("E_RANGE", "timeout code required");
    const events = this._readAllEvents(this._load());
    const matches = [];
    for (let i = 0; i < events.length; i++) {
      if (events[i].code !== timeout) continue;
      const lo = Math.max(0, i - window);
      const hi = Math.min(events.length - 1, i + window);
      for (let j = lo; j <= hi; j++) {
        if (j !== i && events[j].code === device) {
          matches.push({
            timeoutSeq: events[i].seq, timeoutTs: events[i].ts,
            deviceSeq: events[j].seq, deviceTs: events[j].ts,
            distance: j - i,
          });
        }
      }
    }
    return { device, timeout, window, count: matches.length, matches };
  }

  queryPhrase(codes) {
    if (!Array.isArray(codes) || codes.length === 0 || codes.some((c) => typeof c !== "string" || !c)) {
      throw new PLCError("E_RANGE", "phrase must be a non-empty list of codes");
    }
    const events = this._readAllEvents(this._load());
    const hits = [];
    for (let i = 0; i + codes.length <= events.length; i++) {
      let ok = true;
      for (let k = 0; k < codes.length; k++) {
        if (events[i + k].code !== codes[k]) { ok = false; break; }
      }
      if (ok) {
        hits.push({
          startSeq: events[i].seq,
          seqs: events.slice(i, i + codes.length).map((e) => e.seq),
          ts: events.slice(i, i + codes.length).map((e) => e.ts),
        });
      }
    }
    return { phrase: codes, count: hits.length, hits };
  }
}
