'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { crc32 } = require('./crc32');
const { PlanError } = require('./errors');
const { validateOrder, planSchedule } = require('./schedule');

// On-disk layout of a store directory:
//   data.bin       append-only sequence of chunks
//   manifest.json  committed index: chunk offsets/lengths/crc + checkpoints
//   manifest.tmp   transient; renamed onto manifest.json (commit point)
//
// Chunk layout in data.bin:
//   u32le magic (0x504c4348 "PLCH")
//   u32le payload length
//   payload bytes (UTF-8 JSON record)
//   u32le crc32(payload)
//
// Append protocol: chunk bytes are appended to data.bin and fsynced first,
// then the updated manifest is written to manifest.tmp, fsynced and renamed.
// A crash before the rename leaves an unindexed tail in data.bin which is
// truncated on open; a crash after the rename makes the chunk fully visible.

const MAGIC = 0x504c4348;
const HEADER_LEN = 8;
const TRAILER_LEN = 4;
const DATA_FILE = 'data.bin';
const MANIFEST_FILE = 'manifest.json';
const MANIFEST_TMP = 'manifest.tmp';

function encodeChunk(payload) {
  const chunk = Buffer.alloc(HEADER_LEN + payload.length + TRAILER_LEN);
  chunk.writeUInt32LE(MAGIC, 0);
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, HEADER_LEN);
  chunk.writeUInt32LE(crc32(payload), HEADER_LEN + payload.length);
  return chunk;
}

function emptyManifest() {
  return { version: 1, chunks: [], checkpoints: {} };
}

function fsyncDirBestEffort(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is not supported on every platform; best effort only.
  }
}

function writeManifestAtomic(dir, manifest) {
  const tmp = path.join(dir, MANIFEST_TMP);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(manifest, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path.join(dir, MANIFEST_FILE));
  fsyncDirBestEffort(dir);
}

function applyRecord(state, record) {
  if (record === null || typeof record !== 'object' || record.t !== 'order') {
    throw new PlanError('E_INDEX', `unknown record type in chunk: ${JSON.stringify(record)}`);
  }
  const order = validateOrder(record.order);
  state.orders.push(order);
  state.loads[order.machine] = (state.loads[order.machine] || 0) + order.quantity;
}

class Store {
  constructor(dir, manifest, dataSize) {
    this.dir = dir;
    this.dataPath = path.join(dir, DATA_FILE);
    this.manifest = manifest;
    this.dataSize = dataSize;
    this.orders = [];
    this.loads = {};
  }

  static create(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const dataPath = path.join(dir, DATA_FILE);
    const fd = fs.openSync(dataPath, 'w');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    writeManifestAtomic(dir, emptyManifest());
    return Store.open(dir);
  }

  static open(dir) {
    const dataPath = path.join(dir, DATA_FILE);
    const manifestPath = path.join(dir, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      throw new PlanError('E_STATE', `not a plan store (missing manifest): ${dir}`);
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      throw new PlanError('E_INDEX', `manifest is not valid JSON: ${err.message}`);
    }
    if (
      manifest === null ||
      typeof manifest !== 'object' ||
      manifest.version !== 1 ||
      !Array.isArray(manifest.chunks) ||
      manifest.checkpoints === null ||
      typeof manifest.checkpoints !== 'object'
    ) {
      throw new PlanError('E_INDEX', 'manifest has an invalid shape');
    }

    // Validate the offset index and recover from a crash before rename:
    // any tail of data.bin beyond the indexed region is invisible garbage.
    let expected = 0;
    for (let i = 0; i < manifest.chunks.length; i += 1) {
      const entry = manifest.chunks[i];
      if (
        !Number.isInteger(entry.offset) ||
        !Number.isInteger(entry.length) ||
        !Number.isInteger(entry.crc32) ||
        entry.offset !== expected ||
        entry.length < HEADER_LEN + TRAILER_LEN
      ) {
        throw new PlanError('E_INDEX', `manifest index inconsistent at chunk ${i}`, { chunk: i });
      }
      expected += entry.length;
    }
    const actual = fs.existsSync(dataPath) ? fs.statSync(dataPath).size : 0;
    if (actual < expected) {
      throw new PlanError('E_INDEX', `data file shorter than index: ${actual} < ${expected}`);
    }
    if (actual > expected) {
      const fd = fs.openSync(dataPath, 'r+');
      try {
        fs.ftruncateSync(fd, expected);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }

    const store = new Store(dir, manifest, expected);
    const state = store.decode();
    store.orders = state.orders;
    store.loads = state.loads;
    return store;
  }

  // Incremental decode: chunks are read and CRC-checked one at a time while
  // the machine load accumulator is maintained. On a CRC failure the thrown
  // PlanError carries `chunk` (the failing chunk number) and `state` (the
  // fully decoded, consistent prefix); nothing past the bad chunk is applied.
  decode(onChunk) {
    const state = { orders: [], loads: {} };
    const fd = fs.openSync(this.dataPath, 'r');
    try {
      for (let i = 0; i < this.manifest.chunks.length; i += 1) {
        const entry = this.manifest.chunks[i];
        const raw = Buffer.alloc(entry.length);
        const read = fs.readSync(fd, raw, 0, entry.length, entry.offset);
        if (read !== entry.length) {
          throw new PlanError('E_INDEX', `chunk ${i}: short read (${read} of ${entry.length})`, {
            chunk: i,
            state,
          });
        }
        if (raw.readUInt32LE(0) !== MAGIC) {
          throw new PlanError('E_INDEX', `chunk ${i}: bad magic at offset ${entry.offset}`, {
            chunk: i,
            state,
          });
        }
        const payloadLen = raw.readUInt32LE(4);
        if (HEADER_LEN + payloadLen + TRAILER_LEN !== entry.length) {
          throw new PlanError('E_INDEX', `chunk ${i}: length mismatch with index`, {
            chunk: i,
            state,
          });
        }
        const payload = raw.subarray(HEADER_LEN, HEADER_LEN + payloadLen);
        const storedCrc = raw.readUInt32LE(HEADER_LEN + payloadLen);
        const actualCrc = crc32(payload);
        if (actualCrc !== storedCrc || actualCrc !== entry.crc32) {
          throw new PlanError(
            'E_CRC',
            `chunk ${i}: crc32 mismatch (computed ${actualCrc}, stored ${storedCrc}); ` +
              `prefix of ${i} chunk(s) is decodable`,
            { chunk: i, state },
          );
        }
        let record;
        try {
          record = JSON.parse(payload.toString('utf8'));
        } catch {
          throw new PlanError('E_INDEX', `chunk ${i}: payload is not valid JSON`, {
            chunk: i,
            state,
          });
        }
        applyRecord(state, record);
        if (onChunk) onChunk(i, record, state);
      }
    } finally {
      fs.closeSync(fd);
    }
    return state;
  }

  appendOrder(order) {
    const normalized = validateOrder(order);
    if (this.orders.some((o) => o.id === normalized.id)) {
      throw new PlanError('E_USAGE', `duplicate order id: ${normalized.id}`);
    }
    const payload = Buffer.from(JSON.stringify({ t: 'order', order: normalized }), 'utf8');
    const chunk = encodeChunk(payload);
    const offset = this.dataSize;
    const fd = fs.openSync(this.dataPath, 'a');
    try {
      fs.writeFileSync(fd, chunk);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.manifest.chunks.push({ offset, length: chunk.length, crc32: crc32(payload) });
    writeManifestAtomic(this.dir, this.manifest);
    this.dataSize += chunk.length;
    applyRecord(this, { t: 'order', order: normalized });
    return this.manifest.chunks.length - 1;
  }

  checkpoint(name) {
    if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) {
      throw new PlanError('E_USAGE', `invalid checkpoint name: ${JSON.stringify(name)}`);
    }
    if (this.manifest.checkpoints[name]) {
      throw new PlanError('E_STATE', `checkpoint already exists: ${name}`);
    }
    this.manifest.checkpoints[name] = {
      chunks: this.manifest.chunks.length,
      loads: { ...this.loads },
    };
    writeManifestAtomic(this.dir, this.manifest);
    return { name, chunks: this.manifest.chunks.length };
  }

  // Rolls back to a named checkpoint using only the manifest index and the
  // checkpoint's load snapshot; rolled-back chunks are never decoded.
  rollback(name) {
    const cp = this.manifest.checkpoints[name];
    if (!cp) {
      throw new PlanError('E_STATE', `unknown checkpoint: ${name}`);
    }
    this.manifest.chunks.length = cp.chunks;
    for (const [cpName, entry] of Object.entries(this.manifest.checkpoints)) {
      if (entry.chunks > cp.chunks) delete this.manifest.checkpoints[cpName];
    }
    const size =
      cp.chunks === 0
        ? 0
        : this.manifest.chunks[cp.chunks - 1].offset + this.manifest.chunks[cp.chunks - 1].length;
    const fd = fs.openSync(this.dataPath, 'r+');
    try {
      fs.ftruncateSync(fd, size);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    writeManifestAtomic(this.dir, this.manifest);
    this.dataSize = size;
    this.orders = this.orders.slice(0, cp.chunks);
    this.loads = { ...cp.loads };
    return { name, chunks: cp.chunks };
  }

  schedule(capacity) {
    return planSchedule(this.orders, capacity);
  }
}

module.exports = {
  Store,
  encodeChunk,
  MAGIC,
  HEADER_LEN,
  TRAILER_LEN,
  DATA_FILE,
  MANIFEST_FILE,
  MANIFEST_TMP,
};
