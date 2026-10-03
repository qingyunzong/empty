'use strict';

const fs = require('node:fs');
const {
  KIND,
  ZERO_HASH_HEX,
  encodeChunk,
  decodeChunk,
  chunkHash,
} = require('./chunk');
const { initialState, applyLayer } = require('./state');
const { CorruptError } = require('./errors');

function indexPathOf(dataFile) {
  return `${dataFile}.idx`;
}

function readIndex(dataFile) {
  const idxFile = indexPathOf(dataFile);
  if (!fs.existsSync(idxFile)) return [];
  const lines = fs.readFileSync(idxFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
  return lines.map((line, i) => {
    try {
      const e = JSON.parse(line);
      if (!Number.isSafeInteger(e.seq) || !Number.isSafeInteger(e.offset) || typeof e.hash !== 'string') {
        throw new Error('bad shape');
      }
      return e;
    } catch {
      throw new CorruptError(`index corrupt: unparseable entry ${i + 1} in ${idxFile}`);
    }
  });
}

function readChunkAt(dataFile, offset) {
  const fd = fs.openSync(dataFile, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    if (offset >= size) throw new CorruptError(`index corrupt: offset ${offset} beyond end of file`);
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    return decodeChunk(buf, 0).chunk;
  } finally {
    fs.closeSync(fd);
  }
}

// Reads the chunk an index entry points to and enforces that the layer number
// and hash match. Any mismatch is treated as index corruption.
function readLinkedChunk(dataFile, entry) {
  const chunk = readChunkAt(dataFile, entry.offset);
  if (!chunk.crcOk) {
    throw new CorruptError(`data corrupt: CRC mismatch at layer ${entry.seq} (offset ${entry.offset})`);
  }
  if (chunk.seq !== entry.seq || chunk.hash !== entry.hash) {
    throw new CorruptError(
      `index corrupt: entry seq=${entry.seq} offset=${entry.offset} does not match chunk seq=${chunk.seq}`,
    );
  }
  return chunk;
}

// Sequentially scans the data file. Returns every structurally decodable
// chunk (linked or orphan) plus the size of an undecodable torn tail.
function scanChunks(dataFile) {
  if (!fs.existsSync(dataFile)) return { chunks: [], tornBytes: 0 };
  const buf = fs.readFileSync(dataFile);
  const chunks = [];
  let pos = 0;
  let tornBytes = 0;
  while (pos < buf.length) {
    try {
      const { chunk, bytesRead } = decodeChunk(buf, pos);
      chunk.offset = pos;
      chunks.push(chunk);
      pos += bytesRead;
    } catch {
      tornBytes = buf.length - pos;
      break;
    }
  }
  return { chunks, tornBytes };
}

function lastLinked(dataFile) {
  const entries = readIndex(dataFile);
  if (entries.length === 0) return { seq: 0, hash: ZERO_HASH_HEX };
  return entries[entries.length - 1];
}

function appendLinked(dataFile, encoded, entry) {
  const offset = fs.existsSync(dataFile) ? fs.statSync(dataFile).size : 0;
  fs.appendFileSync(dataFile, encoded);
  fs.appendFileSync(indexPathOf(dataFile), `${JSON.stringify({ ...entry, offset })}\n`);
  return offset;
}

function applyDelta(state, chunk) {
  return applyLayer(state, chunk.kind, chunk.payload.txs, chunk.seq);
}

// Loads current state using the latest checkpoint plus subsequent deltas
// (never replays the whole file when a checkpoint exists).
function loadState(dataFile) {
  return restore(dataFile, { checkpoint: true, strict: true }).state;
}

function commitLayer(dataFile, kind, txs) {
  if (!KIND[kind] || kind === 'checkpoint') throw new CorruptError(`cannot commit kind ${kind}`);
  const state = loadState(dataFile);
  const seq = state.seq + 1;
  txs = txs.map((tx, i) => (tx.id ? tx : { ...tx, id: `${tx.op}-${seq}-${i + 1}` }));
  const next = applyLayer(state, kind, txs, seq); // throws BusinessError before anything is written
  const parentHash = lastLinked(dataFile).hash;
  const encoded = encodeChunk({ kind, seq, parentHash, payload: { txs } });
  const offset = appendLinked(dataFile, encoded, { seq, hash: chunkHash(encoded), kind });
  return { seq, offset, hash: chunkHash(encoded), state: next };
}

function commitCheckpoint(dataFile) {
  const state = loadState(dataFile);
  const seq = state.seq + 1;
  const snapshot = { ...structuredClone(state), seq, lastCheckpointSeq: seq };
  const parentHash = lastLinked(dataFile).hash;
  const encoded = encodeChunk({ kind: 'checkpoint', seq, parentHash, payload: { state: snapshot } });
  const offset = appendLinked(dataFile, encoded, { seq, hash: chunkHash(encoded), kind: 'checkpoint' });
  return { seq, offset, hash: chunkHash(encoded), state: snapshot };
}

// restore modes:
//  - full: replay every linked layer from genesis. Any corruption throws.
//  - checkpoint (default when opts.checkpoint): start from the latest
//    checkpoint (<= opts.to when given) and apply subsequent deltas.
//    Without opts.to, stops cleanly before the first corrupt delta
//    (stoppedAtCorruption set). With opts.to, failing to reach it throws.
function restore(dataFile, opts = {}) {
  const useCheckpoint = Boolean(opts.checkpoint);
  const to = opts.to === undefined ? null : opts.to;
  const strict = Boolean(opts.strict);
  const entries = readIndex(dataFile);

  let state = initialState();
  let startIndex = 0;
  let checkpointSeq = 0;

  if (useCheckpoint && entries.length > 0) {
    let cpIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].kind === 'checkpoint' && (to === null || entries[i].seq <= to)) {
        cpIndex = i;
        break;
      }
    }
    if (cpIndex >= 0) {
      const chunk = readLinkedChunk(dataFile, entries[cpIndex]);
      state = structuredClone(chunk.payload.state);
      startIndex = cpIndex + 1;
      checkpointSeq = chunk.seq;
    }
  }

  let stoppedAtCorruption = null;
  let prevHash = startIndex > 0 ? entries[startIndex - 1].hash : ZERO_HASH_HEX;
  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i];
    if (to !== null && entry.seq > to) break;
    let chunk;
    try {
      chunk = readLinkedChunk(dataFile, entry);
      if (chunk.parentHash !== prevHash) {
        throw new CorruptError(`chain broken at layer ${entry.seq}: parent hash mismatch`);
      }
      if (chunk.kind === 'checkpoint') {
        state = structuredClone(chunk.payload.state);
      } else {
        state = applyDelta(state, chunk);
      }
      prevHash = chunk.hash;
    } catch (err) {
      if (to === null && useCheckpoint && !strict && err instanceof CorruptError) {
        stoppedAtCorruption = { seq: entry.seq, offset: entry.offset, reason: err.message };
        break;
      }
      throw err;
    }
  }

  if (to !== null && state.seq < to) {
    throw new CorruptError(`cannot reach layer ${to}: chain stops at layer ${state.seq}`);
  }
  return { state, checkpointSeq, stoppedAtCorruption };
}

// Verifies index vs data file and reports orphans (complete chunks never
// linked into the index) and torn tails (partial writes). Orphans are
// reported but never merged into state and do not fail verification.
function verify(dataFile) {
  const errors = [];
  const entries = readIndex(dataFile);
  const { chunks, tornBytes } = scanChunks(dataFile);
  const byOffset = new Map(chunks.map((c) => [c.offset, c]));
  const linkedOffsets = new Set(entries.map((e) => e.offset));

  for (const entry of entries) {
    const chunk = byOffset.get(entry.offset);
    if (!chunk) {
      errors.push({ type: 'INDEX_MISMATCH', seq: entry.seq, offset: entry.offset });
      continue;
    }
    if (!chunk.crcOk) {
      errors.push({ type: 'CRC_MISMATCH', seq: entry.seq, offset: entry.offset });
      continue;
    }
    if (chunk.seq !== entry.seq || chunk.hash !== entry.hash) {
      errors.push({ type: 'INDEX_MISMATCH', seq: entry.seq, offset: entry.offset });
    }
  }

  const linked = entries
    .map((e) => byOffset.get(e.offset))
    .filter((c) => c && c.crcOk)
    .sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < linked.length; i++) {
    const expectedParent = i === 0 ? ZERO_HASH_HEX : linked[i - 1].hash;
    if (linked[i].parentHash !== expectedParent) {
      errors.push({ type: 'CHAIN_BROKEN', seq: linked[i].seq });
    }
    if (i > 0 && linked[i].seq !== linked[i - 1].seq + 1) {
      errors.push({ type: 'SEQ_GAP', seq: linked[i].seq });
    }
  }

  const orphans = chunks
    .filter((c) => c.crcOk && !linkedOffsets.has(c.offset))
    .map((c) => ({ offset: c.offset, seq: c.seq, kind: c.kind, hash: c.hash }));

  return {
    ok: errors.length === 0,
    layers: entries.length,
    lastSeq: entries.length ? entries[entries.length - 1].seq : 0,
    errors,
    orphans,
    tornBytes,
  };
}

module.exports = {
  indexPathOf,
  readIndex,
  readChunkAt,
  scanChunks,
  commitLayer,
  commitCheckpoint,
  restore,
  verify,
  loadState,
};
