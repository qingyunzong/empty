'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { MAGIC, encodeBlock, encodeRecords } = require('./format');
const { QlinError } = require('./errors');

const DEFAULT_BLOCK_RECORDS = 8;

function paths(base) {
  return {
    data: base + '.dat',
    manifest: base + '.manifest.json',
    index: base + '.index.json',
    pending: base + '.pending',
  };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Atomic replace: write temp file, fsync, rename over the target.
function atomicWriteFile(path, data) {
  const tmp = path + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path);
}

function validateRecord(rec) {
  if (!rec || typeof rec.lot !== 'string' || rec.lot.length === 0) {
    throw new QlinError('E_ARGS', 'record requires a non-empty string lot');
  }
  if (rec.lot.includes('/') || rec.lot.includes('\\') || rec.lot.includes('\n')) {
    throw new QlinError('E_ARGS', 'lot contains illegal characters');
  }
  const parents = rec.parents === undefined ? [] : rec.parents;
  if (!Array.isArray(parents) || parents.some((p) => typeof p !== 'string' || p.length === 0)) {
    throw new QlinError('E_ARGS', 'parents must be an array of non-empty strings');
  }
  return {
    lot: rec.lot,
    parents: [...new Set(parents)],
    op: typeof rec.op === 'string' ? rec.op : '',
    verdict: typeof rec.verdict === 'string' ? rec.verdict : '',
  };
}

class Writer {
  // Open an existing database for appending.
  constructor(base, opts = {}) {
    const p = paths(base);
    if (!fs.existsSync(p.data) || !fs.existsSync(p.manifest) || !fs.existsSync(p.index)) {
      throw new QlinError('E_NOTFOUND', `database not found at ${base}; run init first`);
    }
    this.base = base;
    this.paths = p;
    this.manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
    this.index = JSON.parse(fs.readFileSync(p.index, 'utf8'));
    this.blockRecords = opts.blockRecords || this.manifest.blockRecords || DEFAULT_BLOCK_RECORDS;
    this.dataSize = fs.statSync(p.data).size;
  }

  static init(base, opts = {}) {
    const p = paths(base);
    if (fs.existsSync(p.data) || fs.existsSync(p.manifest) || fs.existsSync(p.index)) {
      throw new QlinError('E_EXISTS', `database already exists at ${base}`);
    }
    const blockRecords = opts.blockRecords || DEFAULT_BLOCK_RECORDS;
    const fd = fs.openSync(p.data, 'w');
    try {
      fs.writeSync(fd, MAGIC);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    atomicWriteFile(p.manifest, JSON.stringify({ version: 1, blockRecords, blocks: [] }, null, 2));
    atomicWriteFile(p.index, JSON.stringify({ version: 1, lots: {} }, null, 2));
    return new Writer(base, opts);
  }

  _readPending() {
    if (!fs.existsSync(this.paths.pending)) return [];
    const text = fs.readFileSync(this.paths.pending, 'utf8');
    return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
  }

  add(rec) {
    const record = validateRecord(rec);
    if (this.index.lots[record.lot] || this._readPending().some((r) => r.lot === record.lot)) {
      throw new QlinError('E_EXISTS', `duplicate lot ${record.lot}`);
    }
    fs.appendFileSync(this.paths.pending, JSON.stringify(record) + '\n');
    if (this._readPending().length >= this.blockRecords) {
      this.seal();
    }
    return record;
  }

  // Flush pending records as one sealed block, then atomically update
  // manifest (first) and index (second).
  seal() {
    const records = this._readPending();
    if (records.length === 0) return null;

    const { payload, entries } = encodeRecords(records);
    const block = encodeBlock(payload);
    const blockId = this.manifest.blocks.length;
    const blockOffset = this.dataSize;

    const fd = fs.openSync(this.paths.data, 'r+');
    try {
      fs.writeSync(fd, block, 0, block.length, blockOffset);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.dataSize += block.length;

    this.manifest.blocks.push({
      id: blockId,
      offset: blockOffset,
      length: block.length,
      sha256: sha256(block),
    });
    atomicWriteFile(this.paths.manifest, JSON.stringify(this.manifest, null, 2));

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const abs = blockOffset + 8 + entries[i].relOffset;
      this.index.lots[rec.lot] = {
        block: blockId,
        offset: abs,
        length: entries[i].length,
        parents: rec.parents,
      };
    }
    atomicWriteFile(this.paths.index, JSON.stringify(this.index, null, 2));

    fs.rmSync(this.paths.pending, { force: true });
    return blockId;
  }
}

module.exports = { Writer, paths, atomicWriteFile, sha256, DEFAULT_BLOCK_RECORDS };
