'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Secondary indexes, kept in memory and persisted to disk after each commit.
// - NameIndex: target name -> ordered list of record ids (commit order)
// - TimeIndex: commit timestamp -> record ids, sorted by ts (ts is monotonic)
//
// On-disk format (JSON): { walSeq, crc, data }
// where crc = crc32 of JSON.stringify(data). A file that is missing,
// unparseable, crc-mismatched, or behind the WAL is rebuilt from the WAL.

class NameIndex {
  constructor() {
    this.map = new Map(); // name -> string[]
  }

  add(rec) {
    let list = this.map.get(rec.target);
    if (!list) {
      list = [];
      this.map.set(rec.target, list);
    }
    list.push(rec.id);
  }

  ids(name) {
    return this.map.get(name) || [];
  }

  toData() {
    return [...this.map.entries()];
  }

  static fromData(entries) {
    const idx = new NameIndex();
    idx.map = new Map(entries);
    return idx;
  }
}

class TimeIndex {
  constructor() {
    this.entries = []; // [{ts, id}] sorted by ts (ts is monotonic per engine)
  }

  add(rec) {
    this.entries.push({ ts: rec.ts, id: rec.id });
  }

  // ids with from <= ts <= to (inclusive bounds, either may be null)
  range(from, to) {
    const out = [];
    for (const e of this.entries) {
      if (from !== null && e.ts < from) continue;
      if (to !== null && e.ts > to) continue;
      out.push(e.id);
    }
    return out;
  }

  upTo(ts) {
    return this.range(null, ts);
  }

  toData() {
    return this.entries;
  }

  static fromData(entries) {
    const idx = new TimeIndex();
    idx.entries = entries;
    return idx;
  }
}

function persistIndex(file, walSeq, data) {
  const body = JSON.stringify(data);
  const payload = JSON.stringify({ walSeq, crc: zlib.crc32(Buffer.from(body, 'utf8')), data });
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, payload);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file); // atomic replace
}

// Returns { walSeq, data } or null if the file is missing/corrupt.
function loadIndex(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return null;
    const body = JSON.stringify(obj.data);
    if (zlib.crc32(Buffer.from(body, 'utf8')) !== obj.crc) return null;
    if (typeof obj.walSeq !== 'number') return null;
    return { walSeq: obj.walSeq, data: obj.data };
  } catch {
    return null;
  }
}

class IndexStore {
  constructor(dir) {
    this.dir = dir;
    this.nameFile = path.join(dir, 'index-name.json');
    this.timeFile = path.join(dir, 'index-time.json');
  }

  persist(walSeq, nameIndex, timeIndex) {
    fs.mkdirSync(this.dir, { recursive: true });
    persistIndex(this.nameFile, walSeq, nameIndex.toData());
    persistIndex(this.timeFile, walSeq, timeIndex.toData());
  }

  // Returns { walSeq, nameIndex, timeIndex } or null if either file is unusable.
  load() {
    const n = loadIndex(this.nameFile);
    const t = loadIndex(this.timeFile);
    if (!n || !t || n.walSeq !== t.walSeq) return null;
    return {
      walSeq: n.walSeq,
      nameIndex: NameIndex.fromData(n.data),
      timeIndex: TimeIndex.fromData(t.data),
    };
  }
}

module.exports = { NameIndex, TimeIndex, IndexStore };
