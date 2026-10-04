'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ArchiveError, E_WINDOW, E_MERGE, E_RETAIN } = require('./errors');
const { tokenize } = require('./tokens');
const { encodeSegment, decodeSegment } = require('./segment');

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  const fd = fs.openSync(tmp, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function emptyManifest() {
  return {
    version: 1,
    segments: [],
    tombstones: [],
    nextSeq: {},
    tokenTotals: {},
    nextSegId: 1,
    lastTs: -1,
    activeCount: 0,
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this._load();
  }

  _paths() {
    return {
      manifest: path.join(this.dir, 'manifest.json'),
      dict: path.join(this.dir, 'dict.json'),
      active: path.join(this.dir, 'active', 'events.jsonl'),
      segmentsDir: path.join(this.dir, 'segments'),
      tmpDir: path.join(this.dir, 'tmp'),
    };
  }

  _load() {
    const p = this._paths();
    if (fs.existsSync(p.manifest)) {
      this.manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
    } else {
      this.manifest = emptyManifest();
    }
    if (fs.existsSync(p.dict)) {
      this.dict = JSON.parse(fs.readFileSync(p.dict, 'utf8'));
    } else {
      this.dict = { version: 0, terms: [] };
    }
    // Self-heal a crash between manifest commit and active-file truncation
    // during freeze: the events are already frozen, drop the stale copy.
    if (this.manifest.activeCount === 0 && fs.existsSync(p.active)) {
      if (fs.readFileSync(p.active, 'utf8').trim() !== '') {
        fs.writeFileSync(p.active, '');
      }
    }
  }

  _ensureDirs() {
    const p = this._paths();
    fs.mkdirSync(p.segmentsDir, { recursive: true });
    fs.mkdirSync(path.dirname(p.active), { recursive: true });
    fs.mkdirSync(p.tmpDir, { recursive: true });
  }

  _saveManifest() {
    this._ensureDirs();
    writeFileAtomic(this._paths().manifest, JSON.stringify(this.manifest, null, 2));
  }

  _saveDict() {
    this._ensureDirs();
    writeFileAtomic(this._paths().dict, JSON.stringify(this.dict));
  }

  _activeEvents() {
    const file = this._paths().active;
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  }

  _segmentFile(entry) {
    return path.join(this._paths().segmentsDir, entry.file);
  }

  _readSegment(entry) {
    return JSON.parse(fs.readFileSync(this._segmentFile(entry), 'utf8'));
  }

  _isDeleted(ev) {
    for (const tomb of this.manifest.tombstones) {
      if (tomb.before !== undefined && ev.ts < tomb.before) return true;
      if (tomb.until !== undefined && ev.ts <= tomb.until) return true;
    }
    return false;
  }

  append({ device, ts, text }) {
    if (typeof device !== 'string' || device === '') {
      throw new ArchiveError(E_WINDOW, 'append requires a non-empty --device');
    }
    if (!Number.isSafeInteger(ts) || ts < 0) {
      throw new ArchiveError(E_WINDOW, `invalid --ts: ${ts}`);
    }
    if (ts < this.manifest.lastTs) {
      throw new ArchiveError(
        E_WINDOW,
        `ts ${ts} is before last appended ts ${this.manifest.lastTs}; stream must be non-decreasing`,
      );
    }
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      throw new ArchiveError(E_WINDOW, 'append produced zero tokens');
    }
    const seq = this.manifest.nextSeq[device] || 0;
    this._ensureDirs();
    const record = JSON.stringify({ ts, device, seq, tokens });
    fs.appendFileSync(this._paths().active, record + '\n');
    this.manifest.nextSeq[device] = seq + 1;
    this.manifest.lastTs = ts;
    this.manifest.activeCount += 1;
    this._saveManifest();
    return { ts, device, seq, tokens };
  }

  freeze() {
    const events = this._activeEvents();
    if (events.length === 0) {
      throw new ArchiveError(E_WINDOW, 'no active events to freeze');
    }
    // Shared dictionary only ever grows; old ids stay valid forever.
    let dictChanged = false;
    const known = new Set(this.dict.terms);
    for (const ev of events) {
      for (const tok of ev.tokens) {
        if (!known.has(tok)) {
          known.add(tok);
          this.dict.terms.push(tok);
          dictChanged = true;
        }
      }
    }
    if (dictChanged) {
      this.dict.version += 1;
      this._saveDict();
    }

    const id = `seg-${String(this.manifest.nextSegId).padStart(4, '0')}`;
    const bases = { ...this.manifest.tokenTotals };
    const seg = encodeSegment({
      id,
      dictVersion: this.dict.version,
      events,
      bases,
      dictTerms: this.dict.terms,
    });
    this._ensureDirs();
    const file = `${id}.json`;
    writeFileAtomic(path.join(this._paths().segmentsDir, file), JSON.stringify(seg));

    for (const ev of events) {
      this.manifest.tokenTotals[ev.device] =
        (this.manifest.tokenTotals[ev.device] || 0) + ev.tokens.length;
    }
    this.manifest.nextSegId += 1;
    this.manifest.segments.push({
      id,
      file,
      from: seg.from,
      to: seg.to,
      count: seg.count,
      bases,
    });
    this.manifest.activeCount = 0;
    this._saveManifest();
    // Committed; clear the active file (crash before this is healed on load).
    fs.writeFileSync(this._paths().active, '');
    return { id, count: seg.count, from: seg.from, to: seg.to };
  }

  mergeWindow(from, to) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) {
      throw new ArchiveError(E_WINDOW, `invalid merge window [${from}, ${to}]`);
    }
    const segs = this.manifest.segments;
    const covered = [];
    segs.forEach((s, idx) => {
      if (s.from >= from && s.to <= to) covered.push(idx);
    });
    if (covered.length < 2) {
      throw new ArchiveError(
        E_WINDOW,
        `merge window [${from}, ${to}] covers ${covered.length} frozen segment(s); need at least 2`,
      );
    }
    for (let i = 1; i < covered.length; i++) {
      if (covered[i] !== covered[i - 1] + 1) {
        throw new ArchiveError(E_WINDOW, 'merge window segments are not contiguous');
      }
    }

    try {
      // Snapshot the replaced entries before mutating the manifest.
      const removed = covered.map((idx) => ({ ...segs[idx] }));
      const events = [];
      for (const idx of covered) {
        events.push(...decodeSegment(this._readSegment(segs[idx]), this.dict.terms));
      }
      // Absolute positions before the window come from the first covered
      // segment; a missing device means it had no tokens before the window.
      const bases = { ...segs[covered[0]].bases };
      const id = `seg-${String(this.manifest.nextSegId).padStart(4, '0')}`;
      const merged = encodeSegment({
        id,
        dictVersion: this.dict.version,
        events,
        bases,
        dictTerms: this.dict.terms,
      });

      // Stage the replacement window; the old window stays live until commit.
      const stageDir = path.join(this._paths().tmpDir, `merge-${id}`);
      fs.mkdirSync(stageDir, { recursive: true });
      const stagedFile = path.join(stageDir, `${id}.json`);
      writeFileAtomic(stagedFile, JSON.stringify(merged));

      if (process.env.ARCHIVE_TEST_KILL === 'after-stage') {
        process.exit(137); // test hook: simulate a kill mid-merge
      }

      const file = `${id}.json`;
      fs.renameSync(stagedFile, path.join(this._paths().segmentsDir, file));
      fs.rmdirSync(stageDir);

      const entry = {
        id,
        file,
        from: merged.from,
        to: merged.to,
        count: merged.count,
        bases,
      };
      this.manifest.segments.splice(covered[0], covered.length, entry);
      this.manifest.nextSegId += 1;
      this._saveManifest(); // atomic commit: old window replaced in one rename

      for (const old of removed) {
        fs.rmSync(this._segmentFile(old), { force: true });
      }
      return entry;
    } catch (err) {
      if (err instanceof ArchiveError) throw err;
      throw new ArchiveError(E_MERGE, `merge failed: ${err.message}`);
    }
  }

  retain({ before, until }) {
    if ((before === undefined) === (until === undefined)) {
      throw new ArchiveError(E_RETAIN, 'retain requires exactly one of --before / --until');
    }
    const ts = before !== undefined ? before : until;
    if (!Number.isSafeInteger(ts) || ts < 0) {
      throw new ArchiveError(E_RETAIN, `invalid retain timestamp: ${ts}`);
    }
    try {
      // Tombstone by time window; physical data is left in place.
      this.manifest.tombstones.push(
        before !== undefined ? { before } : { until },
      );
      this._saveManifest();
      return this.manifest.tombstones[this.manifest.tombstones.length - 1];
    } catch (err) {
      if (err instanceof ArchiveError) throw err;
      throw new ArchiveError(E_RETAIN, `retain failed: ${err.message}`);
    }
  }

  // All events (frozen + active) with absolute per-device token positions.
  _positionedEvents() {
    const out = [];
    for (const entry of this.manifest.segments) {
      const events = decodeSegment(this._readSegment(entry), this.dict.terms);
      const offsets = { ...entry.bases };
      for (const ev of events) {
        const absStart = offsets[ev.device] || 0;
        offsets[ev.device] = absStart + ev.tokens.length;
        out.push({ ...ev, absStart, deleted: this._isDeleted(ev) });
      }
    }
    const activeOffsets = { ...this.manifest.tokenTotals };
    for (const ev of this._activeEvents()) {
      const absStart = activeOffsets[ev.device] || 0;
      activeOffsets[ev.device] = absStart + ev.tokens.length;
      out.push({ ...ev, absStart, deleted: this._isDeleted(ev) });
    }
    return out;
  }

  // Per-device token runs. Tombstoned events occupy their positions but break
  // the stream, so phrase/near matches never span a deleted event.
  _deviceRuns() {
    const byDevice = new Map();
    for (const ev of this._positionedEvents()) {
      if (!byDevice.has(ev.device)) byDevice.set(ev.device, []);
      byDevice.get(ev.device).push(ev);
    }
    const runsByDevice = new Map();
    for (const [device, events] of byDevice) {
      events.sort((a, b) => a.absStart - b.absStart);
      const runs = [];
      let run = null;
      for (const ev of events) {
        const endPos = run ? run.startPos + run.tokens.length : -1;
        if (ev.deleted || run === null || ev.absStart !== endPos) {
          run = { device, startPos: ev.absStart, tokens: [], events: [] };
          runs.push(run);
        }
        if (!ev.deleted) {
          run.events.push({
            startIndex: run.tokens.length,
            len: ev.tokens.length,
            ts: ev.ts,
            seq: ev.seq,
          });
          run.tokens.push(...ev.tokens);
        }
      }
      runsByDevice.set(
        device,
        runs.filter((r) => r.tokens.length > 0),
      );
    }
    return runsByDevice;
  }

  _locate(run, index) {
    // Binary search the event containing token index `index` within a run.
    let lo = 0;
    let hi = run.events.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (run.events[mid].startIndex <= index) lo = mid;
      else hi = mid - 1;
    }
    const ev = run.events[lo];
    return { ts: ev.ts, seq: ev.seq };
  }

  query({ phrase, near }) {
    let matches = [];
    if (phrase !== undefined) {
      const need = tokenize(phrase);
      if (need.length === 0) {
        throw new ArchiveError(E_WINDOW, 'empty phrase after normalization');
      }
      matches = this._phraseMatches(need);
    } else if (near !== undefined) {
      const a = tokenize(near.a);
      const b = tokenize(near.b);
      const k = near.k;
      if (a.length !== 1 || b.length !== 1) {
        throw new ArchiveError(E_WINDOW, 'near terms must be single tokens');
      }
      if (!Number.isSafeInteger(k) || k < 0) {
        throw new ArchiveError(E_WINDOW, `invalid near distance: ${k}`);
      }
      matches = this._nearMatches(a[0], b[0], k);
    } else {
      throw new ArchiveError(E_WINDOW, 'query requires --phrase or --near');
    }
    matches.sort(
      (x, y) =>
        x.ts - y.ts ||
        (x.device < y.device ? -1 : x.device > y.device ? 1 : 0) ||
        x.seq - y.seq ||
        x.pos - y.pos,
    );
    return matches;
  }

  _phraseMatches(need) {
    const out = [];
    for (const runs of this._deviceRuns().values()) {
      for (const run of runs) {
        const n = need.length;
        for (let i = 0; i + n <= run.tokens.length; i++) {
          let ok = true;
          for (let j = 0; j < n; j++) {
            if (run.tokens[i + j] !== need[j]) {
              ok = false;
              break;
            }
          }
          if (ok) {
            const { ts, seq } = this._locate(run, i);
            out.push({ device: run.device, ts, seq, pos: run.startPos + i });
          }
        }
      }
    }
    return out;
  }

  _nearMatches(a, b, k) {
    const out = [];
    for (const runs of this._deviceRuns().values()) {
      for (const run of runs) {
        const posA = [];
        const posB = [];
        for (let i = 0; i < run.tokens.length; i++) {
          if (run.tokens[i] === a) posA.push(i);
          if (run.tokens[i] === b) posB.push(i);
        }
        const seen = new Set();
        for (const i of posA) {
          for (const j of posB) {
            if (i === j) continue;
            if (Math.abs(i - j) > k) continue;
            const start = Math.min(i, j);
            if (seen.has(start)) continue;
            seen.add(start);
            const { ts, seq } = this._locate(run, start);
            out.push({ device: run.device, ts, seq, pos: run.startPos + start });
          }
        }
      }
    }
    return out;
  }

  stats() {
    const frozenEvents = this.manifest.segments.reduce((n, s) => n + s.count, 0);
    return {
      segments: this.manifest.segments.map((s) => ({
        id: s.id,
        from: s.from,
        to: s.to,
        count: s.count,
      })),
      events: {
        active: this.manifest.activeCount,
        frozen: frozenEvents,
        total: frozenEvents + this.manifest.activeCount,
      },
      tombstones: this.manifest.tombstones,
      dict: { version: this.dict.version, terms: this.dict.terms.length },
      devices: { ...this.manifest.nextSeq },
    };
  }
}

module.exports = { Store };
