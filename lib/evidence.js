'use strict';

// Evidence-pack core library: fixed-size blocks + variable tail block,
// per-block SHA256 table, Merkle root, range proofs, verification.

const crypto = require('node:crypto');
const fs = require('node:fs');

const DEFAULT_BLOCK_SIZE = 4096;
const INDEX_FORMAT = 'evidence-pack/1';
const PROOF_FORMAT = 'evidence-proof/1';

class EvidenceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
    if (details) Object.assign(this, details);
  }

  toJSON() {
    const out = { error: this.code, message: this.message };
    for (const key of ['leaves', 'expected', 'actual', 'scannedRoot', 'file']) {
      if (this[key] !== undefined) out[key] = this[key];
    }
    return out;
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function isHexHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validateBlockSize(blockSize) {
  if (!Number.isSafeInteger(blockSize) || blockSize < 1) {
    throw new EvidenceError('ERR_FORMAT', `invalid blockSize: ${blockSize}`);
  }
}

function blockCountFor(fileSize, blockSize) {
  if (fileSize === 0) return 0;
  return Math.ceil(fileSize / blockSize);
}

// Merkle root over leaf hashes; odd node at a level is promoted upward.
// Empty leaf set hashes to sha256 of the empty string.
function merkleRoot(leafHashes) {
  if (leafHashes.length === 0) return sha256(Buffer.alloc(0));
  let level = leafHashes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256(Buffer.concat([level[i], level[i + 1]])) : level[i]);
    }
    level = next;
  }
  return level[0];
}

function buildLevels(leafHashes) {
  const levels = [leafHashes.slice()];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? sha256(Buffer.concat([cur[i], cur[i + 1]])) : cur[i]);
    }
    levels.push(next);
  }
  return levels;
}

// Split data into fixed-size blocks plus a shorter tail block and build
// the index: per-block {index, offset, length, sha256} plus Merkle root.
function buildIndex(data, blockSize = DEFAULT_BLOCK_SIZE) {
  validateBlockSize(blockSize);
  const count = blockCountFor(data.length, blockSize);
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const offset = i * blockSize;
    const length = Math.min(blockSize, data.length - offset);
    blocks.push({
      index: i,
      offset,
      length,
      sha256: sha256(data.subarray(offset, offset + length)).toString('hex'),
    });
  }
  const root = merkleRoot(blocks.map((b) => Buffer.from(b.sha256, 'hex'))).toString('hex');
  return { format: INDEX_FORMAT, blockSize, fileSize: data.length, blockCount: count, blocks, root };
}

function validateIndex(index) {
  if (!index || typeof index !== 'object' || index.format !== INDEX_FORMAT) {
    throw new EvidenceError('ERR_FORMAT', 'unrecognized index format');
  }
  validateBlockSize(index.blockSize);
  if (!Number.isSafeInteger(index.fileSize) || index.fileSize < 0) {
    throw new EvidenceError('ERR_FORMAT', `invalid fileSize: ${index.fileSize}`);
  }
  if (index.blockCount !== blockCountFor(index.fileSize, index.blockSize)) {
    throw new EvidenceError('ERR_FORMAT', 'blockCount inconsistent with fileSize/blockSize');
  }
  if (!Array.isArray(index.blocks) || index.blocks.length !== index.blockCount) {
    throw new EvidenceError('ERR_FORMAT', 'blocks table length mismatch');
  }
  for (let i = 0; i < index.blocks.length; i++) {
    const b = index.blocks[i];
    const expectLen = Math.min(index.blockSize, index.fileSize - i * index.blockSize);
    if (!b || b.index !== i || b.offset !== i * index.blockSize || b.length !== expectLen || !isHexHash(b.sha256)) {
      throw new EvidenceError('ERR_FORMAT', `malformed block record at index ${i}`);
    }
  }
  if (!isHexHash(index.root)) {
    throw new EvidenceError('ERR_FORMAT', 'malformed root hash');
  }
  return index;
}

// Map a byte range [offset, offset+length) to the covered leaf span.
function leafSpanForRange(offset, length, index) {
  if (
    !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
    offset < 0 || length < 1 || offset + length > index.fileSize
  ) {
    throw new EvidenceError('ERR_RANGE',
      `range [${offset}, ${offset + length}) outside file of ${index.fileSize} bytes`);
  }
  return {
    first: Math.floor(offset / index.blockSize),
    last: Math.floor((offset + length - 1) / index.blockSize),
  };
}

// Build a proof for [offset, offset+length). Per-leaf Merkle paths are
// merged into one set keyed by (level, index) so adjacent proofs dedupe;
// nodes computable from the requested leaves themselves are dropped.
function generateProof(index, offset, length) {
  validateIndex(index);
  const { first, last } = leafSpanForRange(offset, length, index);
  const levels = buildLevels(index.blocks.map((b) => Buffer.from(b.sha256, 'hex')));
  const merged = new Map(); // "level:index" -> hex hash
  for (let leaf = first; leaf <= last; leaf++) {
    let idx = leaf;
    for (let lvl = 0; lvl < levels.length - 1; lvl++) {
      const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sib < levels[lvl].length) merged.set(`${lvl}:${sib}`, levels[lvl][sib].toString('hex'));
      idx = Math.floor(idx / 2);
    }
  }
  let lo = first;
  let hi = last;
  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    for (let i = lo; i <= hi; i++) merged.delete(`${lvl}:${i}`);
    lo = Math.floor(lo / 2);
    hi = Math.floor(hi / 2);
  }
  const path = [...merged.entries()]
    .map(([key, hash]) => {
      const [level, i] = key.split(':').map(Number);
      return { level, index: i, sha256: hash };
    })
    .sort((a, b) => a.level - b.level || a.index - b.index);
  return {
    format: PROOF_FORMAT,
    blockSize: index.blockSize,
    fileSize: index.fileSize,
    blockCount: index.blockCount,
    range: { offset, length },
    firstLeaf: first,
    lastLeaf: last,
    leaves: index.blocks.slice(first, last + 1),
    path,
    root: index.root,
  };
}

// Verify a proof using only the expected root, the proof path and the
// requested range. Throws EvidenceError on failure, returns {ok, root}.
function checkProof(proof, expectedRoot) {
  if (!proof || typeof proof !== 'object' || proof.format !== PROOF_FORMAT) {
    throw new EvidenceError('ERR_FORMAT', 'unrecognized proof format');
  }
  validateBlockSize(proof.blockSize);
  if (!Number.isSafeInteger(proof.fileSize) || proof.fileSize < 0) {
    throw new EvidenceError('ERR_FORMAT', 'invalid proof fileSize');
  }
  if (proof.blockCount !== blockCountFor(proof.fileSize, proof.blockSize)) {
    throw new EvidenceError('ERR_PROOF', 'blockCount inconsistent with fileSize/blockSize');
  }
  if (!proof.range || !Array.isArray(proof.leaves) || !Array.isArray(proof.path)) {
    throw new EvidenceError('ERR_FORMAT', 'proof missing range/leaves/path');
  }
  const span = leafSpanForRange(proof.range.offset, proof.range.length, proof);
  if (span.first !== proof.firstLeaf || span.last !== proof.lastLeaf) {
    throw new EvidenceError('ERR_PROOF', 'leaf span does not match requested range');
  }
  if (proof.leaves.length !== span.last - span.first + 1) {
    throw new EvidenceError('ERR_PROOF', 'leaf count does not match requested range');
  }
  const known = new Map();
  proof.leaves.forEach((leaf, i) => {
    if (!leaf || leaf.index !== span.first + i || !isHexHash(leaf.sha256)) {
      throw new EvidenceError('ERR_PROOF', `malformed leaf at position ${i}`);
    }
    known.set(`0:${leaf.index}`, Buffer.from(leaf.sha256, 'hex'));
  });
  for (const node of proof.path) {
    if (!node || !Number.isSafeInteger(node.level) || !Number.isSafeInteger(node.index) || !isHexHash(node.sha256)) {
      throw new EvidenceError('ERR_FORMAT', 'malformed path node');
    }
    known.set(`${node.level}:${node.index}`, Buffer.from(node.sha256, 'hex'));
  }
  let lo = span.first;
  let hi = span.last;
  let lvl = 0;
  let levelSize = proof.blockCount;
  while (levelSize > 1) {
    const nlo = Math.floor(lo / 2);
    const nhi = Math.floor(hi / 2);
    for (let p = nlo; p <= nhi; p++) {
      const left = known.get(`${lvl}:${2 * p}`);
      if (!left) throw new EvidenceError('ERR_PROOF', `missing node at level ${lvl} index ${2 * p}`);
      let node;
      if (2 * p + 1 < levelSize) {
        const right = known.get(`${lvl}:${2 * p + 1}`);
        if (!right) throw new EvidenceError('ERR_PROOF', `missing node at level ${lvl} index ${2 * p + 1}`);
        node = sha256(Buffer.concat([left, right]));
      } else {
        node = left; // odd node promoted upward
      }
      known.set(`${lvl + 1}:${p}`, node);
    }
    lo = nlo;
    hi = nhi;
    lvl++;
    levelSize = Math.ceil(levelSize / 2);
  }
  const rootHex = known.get(`${lvl}:0`).toString('hex');
  const expected = (expectedRoot || proof.root || '').toLowerCase();
  if (!isHexHash(expected)) {
    throw new EvidenceError('ERR_FORMAT', 'no usable expected root');
  }
  if (rootHex !== expected) {
    throw new EvidenceError('ERR_PROOF', 'proof does not match expected root', { expected, actual: rootHex });
  }
  return { ok: true, root: rootHex };
}

// Verify data against the index.
//  - index table inconsistent with stored root -> ERR_INDEX (degraded scan root attached)
//  - data length differs from index            -> ERR_AMBIGUOUS (cannot uniquely locate)
//  - per-block hash mismatches                 -> ERR_ROOT with minimal leaf set
function verify(data, index) {
  validateIndex(index);
  const scanned = buildIndex(data, index.blockSize);
  const tableRoot = merkleRoot(index.blocks.map((b) => Buffer.from(b.sha256, 'hex'))).toString('hex');
  if (tableRoot !== index.root) {
    throw new EvidenceError('ERR_INDEX',
      'index block table does not match stored root; degraded scan root attached',
      { expected: index.root, actual: tableRoot, scannedRoot: scanned.root });
  }
  if (data.length !== index.fileSize) {
    throw new EvidenceError('ERR_AMBIGUOUS',
      `data length ${data.length} != index fileSize ${index.fileSize}; cannot uniquely locate corrupted leaves`,
      { scannedRoot: scanned.root });
  }
  const bad = [];
  for (let i = 0; i < index.blockCount; i++) {
    if (index.blocks[i].sha256 !== scanned.blocks[i].sha256) bad.push(i);
  }
  if (bad.length > 0) {
    throw new EvidenceError('ERR_ROOT',
      `data does not match index; minimal corrupted leaf set: [${bad.join(', ')}]`,
      { leaves: bad, expected: index.root, actual: scanned.root });
  }
  return { ok: true, root: index.root, blockCount: index.blockCount };
}

// Extract [offset, offset+length) after checking the covered blocks
// against the index; refuses to release bytes that fail integrity.
function extract(data, index, offset, length) {
  validateIndex(index);
  const { first, last } = leafSpanForRange(offset, length, index);
  if (offset + length > data.length) {
    throw new EvidenceError('ERR_RANGE', `data shorter than requested range [${offset}, ${offset + length})`);
  }
  const bad = [];
  for (let i = first; i <= last; i++) {
    const b = index.blocks[i];
    const actual = sha256(data.subarray(b.offset, b.offset + b.length)).toString('hex');
    if (actual !== b.sha256) bad.push(i);
  }
  if (bad.length > 0) {
    throw new EvidenceError('ERR_ROOT',
      `covered blocks failed integrity check: [${bad.join(', ')}]`, { leaves: bad });
  }
  return data.subarray(offset, offset + length);
}

function readJsonFile(path, kind) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new EvidenceError('ERR_IO', `cannot read ${path}: ${err.message}`, { file: path });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EvidenceError('ERR_FORMAT', `invalid JSON in ${kind} file ${path}`, { file: path });
  }
}

function readIndexFile(path) {
  return validateIndex(readJsonFile(path, 'index'));
}

function readProofFile(path) {
  return readJsonFile(path, 'proof');
}

module.exports = {
  DEFAULT_BLOCK_SIZE,
  INDEX_FORMAT,
  PROOF_FORMAT,
  EvidenceError,
  sha256,
  blockCountFor,
  merkleRoot,
  buildIndex,
  validateIndex,
  leafSpanForRange,
  generateProof,
  checkProof,
  verify,
  extract,
  readIndexFile,
  readProofFile,
};
