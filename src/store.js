import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './crc32.js';

export const HEADER_SIZE = 8; // u32 payload length + u32 crc32(payload)
export const DATA_FILE = 'store.dat';
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_TMP = 'manifest.tmp';

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

function dataPath(dir) {
  return path.join(dir, DATA_FILE);
}

function manifestPath(dir) {
  return path.join(dir, MANIFEST_FILE);
}

export function serializeManifest(manifest) {
  return JSON.stringify({
    version: manifest.version,
    capacity: manifest.capacity,
    chunks: manifest.chunks.map((c) => ({
      offset: c.offset,
      length: c.length,
      crc32: c.crc32,
    })),
    checkpoints: manifest.checkpoints,
  }, null, 2) + '\n';
}

function writeManifestAtomic(dir, manifest) {
  const tmp = path.join(dir, MANIFEST_TMP);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, serializeManifest(manifest));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, manifestPath(dir));
}

export function loadManifest(dir) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath(dir), 'utf8');
  } catch {
    throw new StoreError('E_INDEX', `manifest not found in ${dir}; run init first`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new StoreError('E_INDEX', 'manifest is not valid JSON');
  }
  if (
    manifest.version !== 1 ||
    typeof manifest.capacity !== 'number' ||
    !Array.isArray(manifest.chunks) ||
    typeof manifest.checkpoints !== 'object' ||
    manifest.checkpoints === null
  ) {
    throw new StoreError('E_INDEX', 'manifest has an invalid shape');
  }
  return manifest;
}

export function initStore(dir, capacity) {
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new StoreError('E_INPUT', 'capacity must be a positive number');
  }
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(manifestPath(dir))) {
    throw new StoreError('E_INDEX', 'store already initialised');
  }
  fs.writeFileSync(dataPath(dir), Buffer.alloc(0));
  const manifest = { version: 1, capacity, chunks: [], checkpoints: {} };
  writeManifestAtomic(dir, manifest);
  return manifest;
}

export function validateOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    throw new StoreError('E_INPUT', 'orders must be a non-empty array');
  }
  for (const o of orders) {
    if (
      o === null || typeof o !== 'object' ||
      typeof o.id !== 'string' || o.id.length === 0 ||
      !Number.isInteger(o.quantity) || o.quantity <= 0 ||
      typeof o.dueDate !== 'string' || o.dueDate.length === 0 ||
      !Number.isFinite(o.capability) || o.capability <= 0
    ) {
      throw new StoreError('E_INPUT', `invalid work order: ${JSON.stringify(o)}`);
    }
  }
}

function snapshot(state) {
  return { orders: state.orders.slice(), cumulativeLoad: state.cumulativeLoad };
}

// Incremental decode: chunk by chunk, CRC per chunk, cumulative machine load
// maintained after every chunk. Stops at the first corrupt chunk and reports
// its index; the decoded prefix state is attached to the error.
export function decode(dir, manifest) {
  const fd = fs.openSync(dataPath(dir), 'r');
  const state = { orders: [], cumulativeLoad: 0 };
  const states = [snapshot(state)];
  let pos = 0;
  try {
    for (let i = 0; i < manifest.chunks.length; i++) {
      const idx = manifest.chunks[i];
      if (idx.offset !== pos) {
        throw new StoreError('E_INDEX', `chunk ${i}: index offset ${idx.offset} != actual ${pos}`, { chunk: i });
      }
      const header = Buffer.alloc(HEADER_SIZE);
      if (fs.readSync(fd, header, 0, HEADER_SIZE, pos) !== HEADER_SIZE) {
        throw new StoreError('E_INDEX', `chunk ${i}: truncated header`, { chunk: i });
      }
      const length = header.readUInt32LE(0);
      const crc = header.readUInt32LE(4);
      if (idx.length !== length + HEADER_SIZE || idx.crc32 !== crc) {
        throw new StoreError('E_INDEX', `chunk ${i}: index does not match chunk header`, { chunk: i });
      }
      const payload = Buffer.alloc(length);
      if (fs.readSync(fd, payload, 0, length, pos + HEADER_SIZE) !== length) {
        throw new StoreError('E_INDEX', `chunk ${i}: truncated payload`, { chunk: i });
      }
      if (crc32(payload) !== crc) {
        throw new StoreError('E_CRC', `chunk ${i}: CRC32 mismatch`, {
          chunk: i,
          decodedChunks: i,
          state: snapshot(state),
        });
      }
      let batch;
      try {
        batch = JSON.parse(payload.toString('utf8'));
      } catch {
        throw new StoreError('E_INDEX', `chunk ${i}: payload is not valid JSON`, { chunk: i });
      }
      if (batch === null || batch.type !== 'orders' || !Array.isArray(batch.orders)) {
        throw new StoreError('E_INDEX', `chunk ${i}: unknown payload type`, { chunk: i });
      }
      for (const o of batch.orders) {
        state.orders.push(o);
        state.cumulativeLoad += o.quantity * o.capability;
      }
      states.push(snapshot(state));
      pos += HEADER_SIZE + length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { state, states, endOffset: pos };
}

// Append: data chunk is written (and fsynced) past the indexed region first —
// it is an invisible temp tail until the manifest is swapped in via
// manifest.tmp + rename. A crash before the rename leaves the tail invisible.
export function appendOrders(dir, orders) {
  validateOrders(orders);
  const manifest = loadManifest(dir);
  const decoded = decode(dir, manifest);
  // Drop any stale tail from a crashed append before writing our own.
  fs.truncateSync(dataPath(dir), decoded.endOffset);
  const payload = Buffer.from(JSON.stringify({ type: 'orders', orders }), 'utf8');
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt32LE(crc32(payload), 4);
  const chunk = Buffer.concat([header, payload]);
  const fd = fs.openSync(dataPath(dir), 'a');
  try {
    fs.writeSync(fd, chunk);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  manifest.chunks.push({
    offset: decoded.endOffset,
    length: chunk.length,
    crc32: crc32(payload),
  });
  writeManifestAtomic(dir, manifest);
  for (const o of orders) {
    decoded.state.orders.push(o);
    decoded.state.cumulativeLoad += o.quantity * o.capability;
  }
  return { chunk: manifest.chunks.length - 1, state: decoded.state };
}

export function createCheckpoint(dir, name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new StoreError('E_INPUT', 'checkpoint name must be a non-empty string');
  }
  const manifest = loadManifest(dir);
  decode(dir, manifest); // validate before naming a restore point
  manifest.checkpoints[name] = manifest.chunks.length;
  writeManifestAtomic(dir, manifest);
  return { checkpoint: name, chunk: manifest.chunks.length };
}

// Roll back to a named checkpoint. The index is truncated first, so the
// rolled-back chunks are never decoded; the file is then truncated and the
// manifest swapped in atomically.
export function rollback(dir, name) {
  const manifest = loadManifest(dir);
  if (!(name in manifest.checkpoints)) {
    throw new StoreError('E_INPUT', `unknown checkpoint: ${name}`);
  }
  const k = manifest.checkpoints[name];
  manifest.chunks = manifest.chunks.slice(0, k);
  for (const [n, idx] of Object.entries(manifest.checkpoints)) {
    if (idx > k) delete manifest.checkpoints[n];
  }
  const decoded = decode(dir, manifest);
  fs.truncateSync(dataPath(dir), decoded.endOffset);
  writeManifestAtomic(dir, manifest);
  return { checkpoint: name, chunk: k, state: decoded.state };
}

export function verify(dir) {
  const manifest = loadManifest(dir);
  const decoded = decode(dir, manifest);
  return {
    chunks: manifest.chunks.length,
    orders: decoded.state.orders.length,
    cumulativeLoad: decoded.state.cumulativeLoad,
    capacity: manifest.capacity,
  };
}

// Re-derive the manifest from the data file and rewrite it. Used to prove
// that replay after a rollback reproduces a byte-identical manifest.
export function replay(dir) {
  const manifest = loadManifest(dir);
  decode(dir, manifest);
  writeManifestAtomic(dir, manifest);
  return serializeManifest(manifest);
}
