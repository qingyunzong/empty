'use strict';

const fs = require('node:fs');
const {
  MAGIC,
  BLOCK_DICT,
  BLOCK_RECORDS,
  BLOCK_INDEX,
  encodeDictBlockPayload,
  encodeRecordBlockPayload,
  wrapBlock,
  encodeIndex,
  encodeFooter,
} = require('./format');
const { crc32 } = require('./crc32');

function toMs(t) {
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new Error(`invalid time: ${t}`);
  return ms;
}

class PackWriter {
  constructor(path) {
    this.path = path;
    this.manifestPath = `${path}.manifest.json`;
    this.fd = fs.openSync(path, 'w');
    this.offset = 0;
    this.index = [];
    this.version = 0;
    this.dicts = { gtin: new Map(), batch: new Map(), station: new Map() };
    this.nextId = { gtin: 1, batch: 1, station: 1 };
    this.dirty = false;
    this.pending = [];
    this.closed = false;
    this._write(MAGIC);
  }

  _write(buf) {
    fs.writeSync(this.fd, buf);
    this.offset += buf.length;
  }

  _dictId(field, value) {
    const map = this.dicts[field];
    let id = map.get(value);
    if (id === undefined) {
      id = this.nextId[field]++;
      map.set(value, id);
      this.dirty = true;
    }
    return id;
  }

  addTag(tag) {
    if (this.closed) throw new Error('writer is closed');
    this.pending.push({
      gtinId: this._dictId('gtin', String(tag.gtin)),
      batchId: this._dictId('batch', String(tag.batch)),
      stationId: this._dictId('station', String(tag.station)),
      serial: String(tag.serial),
      timeMs: toMs(tag.time),
    });
  }

  _commitDict() {
    this.version += 1;
    const entries = [];
    for (const field of ['gtin', 'batch', 'station']) {
      for (const [value, id] of this.dicts[field]) {
        entries.push({ field, id, value });
      }
    }
    const payload = encodeDictBlockPayload({ version: this.version, entries });
    this._writeBlock(BLOCK_DICT, this.version, payload);
    this._writeManifest();
    this.dirty = false;
  }

  // New dictionary versions take effect only after the manifest is replaced
  // atomically: write a temp file, then rename over the manifest.
  _writeManifest() {
    const manifest = {
      format: 1,
      latest: this.version,
      versions: this.index
        .filter((e) => e.type === BLOCK_DICT)
        .map((e) => ({ version: e.version, offset: e.offset })),
    };
    const tmp = `${this.manifestPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, this.manifestPath);
  }

  _writeBlock(type, version, payload) {
    const raw = wrapBlock(type, payload);
    this.index.push({ offset: this.offset, type, version, totalLen: raw.length });
    this._write(raw);
  }

  flush() {
    if (this.closed) throw new Error('writer is closed');
    if (this.dirty) this._commitDict();
    if (this.pending.length === 0) return;
    const baseTime = Math.min(...this.pending.map((r) => r.timeMs));
    const payload = encodeRecordBlockPayload({
      dictVersion: this.version,
      baseTime,
      records: this.pending,
    });
    this._writeBlock(BLOCK_RECORDS, this.version, payload);
    this.pending = [];
  }

  close() {
    if (this.closed) return;
    this.flush();
    const indexPayload = encodeIndex(this.index);
    const footer = encodeFooter(this.offset, crc32(indexPayload));
    this._write(wrapBlock(BLOCK_INDEX, indexPayload));
    this._write(footer);
    fs.closeSync(this.fd);
    this.closed = true;
  }
}

module.exports = { PackWriter, toMs };
