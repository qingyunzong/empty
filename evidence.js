'use strict';
const crypto = require('node:crypto');

const DEFAULT_BLOCK_SIZE = 4096;
const VERSION = 1;

class EvidenceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function leafHash(index, length, dataHash) {
  const hdr = Buffer.alloc(16);
  hdr.writeBigUInt64BE(BigInt(index), 0);
  hdr.writeBigUInt64BE(BigInt(length), 8);
  return sha256(Buffer.concat([Buffer.from('EVLEAF1'), hdr, dataHash]));
}

function nodeHash(left, right) {
  return sha256(Buffer.concat([Buffer.from('EVNODE1'), left, right]));
}

function emptyRoot() {
  return sha256(Buffer.from('EVEMPTY1'));
}

function chunkBuffer(data, blockSize) {
  const blocks = [];
  for (let offset = 0, index = 0; offset < data.length; offset += blockSize, index++) {
    const slice = data.subarray(offset, Math.min(offset + blockSize, data.length));
    blocks.push({ index, offset, length: slice.length, sha256: sha256(slice).toString('hex') });
  }
  return blocks;
}

function leafHashesOf(blocks) {
  return blocks.map((b) => leafHash(b.index, b.length, Buffer.from(b.sha256, 'hex')));
}

function merkleRootFromLeafHashes(leaves) {
  if (leaves.length === 0) return emptyRoot();
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

function buildIndex(data, blockSize = DEFAULT_BLOCK_SIZE) {
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new EvidenceError('ERR_FORMAT', 'invalid block size');
  }
  const blocks = chunkBuffer(data, blockSize);
  const root = merkleRootFromLeafHashes(leafHashesOf(blocks)).toString('hex');
  return { version: VERSION, blockSize, totalSize: data.length, root, blocks };
}

const HEX64 = /^[0-9a-f]{64}$/;

function validateIndex(index) {
  const bad = (msg) => new EvidenceError('ERR_FORMAT', `invalid index: ${msg}`);
  if (!index || typeof index !== 'object') throw bad('not an object');
  if (index.version !== VERSION) throw bad('unsupported version');
  if (!Number.isInteger(index.blockSize) || index.blockSize <= 0) throw bad('blockSize');
  if (!Number.isInteger(index.totalSize) || index.totalSize < 0) throw bad('totalSize');
  if (typeof index.root !== 'string' || !HEX64.test(index.root)) throw bad('root');
  if (!Array.isArray(index.blocks)) throw bad('blocks');
  let offset = 0;
  index.blocks.forEach((b, i) => {
    if (b.index !== i) throw bad(`block ${i}: index`);
    if (b.offset !== offset) throw bad(`block ${i}: offset not contiguous`);
    if (!Number.isInteger(b.length) || b.length <= 0 || b.length > index.blockSize) throw bad(`block ${i}: length`);
    if (typeof b.sha256 !== 'string' || !HEX64.test(b.sha256)) throw bad(`block ${i}: sha256`);
    offset += b.length;
  });
  if (offset !== index.totalSize) throw bad('blocks do not tile totalSize');
  const expectedLeaves = Math.ceil(index.totalSize / index.blockSize);
  if (index.blocks.length !== expectedLeaves) throw bad('block count mismatch');
}

function scanRoot(data, blockSize = DEFAULT_BLOCK_SIZE) {
  const blocks = chunkBuffer(data, blockSize);
  return { root: merkleRootFromLeafHashes(leafHashesOf(blocks)).toString('hex'), blocks };
}

function localizeAgainstIndex(data, index) {
  if (data.length !== index.totalSize) {
    throw new EvidenceError('ERR_AMBIGUOUS',
      `data size ${data.length} != index totalSize ${index.totalSize}; block boundaries shifted, cannot uniquely locate corruption`,
      { expectedSize: index.totalSize, actualSize: data.length });
  }
  const leaves = [];
  for (const b of index.blocks) {
    const actual = sha256(data.subarray(b.offset, b.offset + b.length)).toString('hex');
    if (actual !== b.sha256) leaves.push(b.index);
  }
  return leaves;
}

function buildProof(leafHashes, startLeaf, endLeaf) {
  const siblings = [];
  let level = leafHashes.slice();
  let lo = startLeaf;
  let hi = endLeaf;
  let lvl = 0;
  while (level.length > 1) {
    if (lo % 2 === 1) {
      siblings.push({ level: lvl, index: lo - 1, hash: level[lo - 1].toString('hex') });
    }
    if (hi % 2 === 0 && hi + 1 < level.length) {
      siblings.push({ level: lvl, index: hi + 1, hash: level[hi + 1].toString('hex') });
    }
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
    }
    level = next;
    lo = Math.floor(lo / 2);
    hi = Math.floor(hi / 2);
    lvl++;
  }
  return siblings;
}

function makeProof(index, offset, length) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0) {
    throw new EvidenceError('ERR_RANGE', `invalid range offset=${offset} length=${length}`);
  }
  if (offset + length > index.totalSize) {
    throw new EvidenceError('ERR_RANGE',
      `range [${offset}, ${offset + length}) exceeds totalSize ${index.totalSize}`);
  }
  const startLeaf = Math.floor(offset / index.blockSize);
  const endLeaf = Math.floor((offset + length - 1) / index.blockSize);
  const leaves = index.blocks.slice(startLeaf, endLeaf + 1)
    .map((b) => ({ index: b.index, length: b.length, sha256: b.sha256 }));
  const siblings = buildProof(leafHashesOf(index.blocks), startLeaf, endLeaf);
  return {
    version: VERSION,
    root: index.root,
    blockSize: index.blockSize,
    totalSize: index.totalSize,
    offset,
    length,
    startLeaf,
    leaves,
    siblings,
  };
}

function hexToBuf(hex, what) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) {
    throw new EvidenceError('ERR_FORMAT', `bad hash encoding for ${what}`);
  }
  return Buffer.from(hex, 'hex');
}

function checkProof(proof, expectedRoot) {
  const bad = (msg) => new EvidenceError('ERR_PROOF', `invalid proof: ${msg}`);
  if (!proof || typeof proof !== 'object') throw bad('not an object');
  if (proof.version !== VERSION) throw bad('unsupported version');
  if (!Number.isInteger(proof.blockSize) || proof.blockSize <= 0) throw bad('blockSize');
  if (!Number.isInteger(proof.totalSize) || proof.totalSize < 0) throw bad('totalSize');
  if (!Number.isInteger(proof.startLeaf) || proof.startLeaf < 0) throw bad('startLeaf');
  if (!Array.isArray(proof.leaves) || proof.leaves.length === 0) throw bad('leaves');
  if (!Array.isArray(proof.siblings)) throw bad('siblings');
  const root = expectedRoot || proof.root;
  if (typeof root !== 'string' || !HEX64.test(root)) throw bad('root');

  const totalLeaves = Math.ceil(proof.totalSize / proof.blockSize);
  if (proof.startLeaf + proof.leaves.length > totalLeaves) throw bad('leaves exceed tree');

  const sibMap = new Map();
  for (const s of proof.siblings) {
    if (!Number.isInteger(s.level) || !Number.isInteger(s.index)) throw bad('sibling entry');
    sibMap.set(`${s.level}:${s.index}`, hexToBuf(s.hash, 'sibling'));
  }

  let known = new Map();
  proof.leaves.forEach((l, k) => {
    if (l.index !== proof.startLeaf + k) throw bad(`leaf ${k}: non-contiguous index`);
    known.set(l.index, leafHash(l.index, l.length, hexToBuf(l.sha256, `leaf ${l.index}`)));
  });

  let levelSize = totalLeaves;
  let lvl = 0;
  while (levelSize > 1) {
    const parents = new Set([...known.keys()].map((i) => i >> 1));
    const next = new Map();
    for (const p of parents) {
      const li = 2 * p;
      const ri = 2 * p + 1;
      let lh = known.get(li);
      if (lh === undefined) lh = sibMap.get(`${lvl}:${li}`);
      if (lh === undefined) throw bad(`missing node at level ${lvl} index ${li}`);
      let parent;
      if (ri >= levelSize) {
        parent = lh;
      } else {
        let rh = known.get(ri);
        if (rh === undefined) rh = sibMap.get(`${lvl}:${ri}`);
        if (rh === undefined) throw bad(`missing node at level ${lvl} index ${ri}`);
        parent = nodeHash(lh, rh);
      }
      next.set(p, parent);
    }
    known = next;
    levelSize = Math.ceil(levelSize / 2);
    lvl++;
  }
  const computed = known.get(0);
  if (!computed) throw bad('empty computation');
  if (computed.toString('hex') !== root) {
    throw new EvidenceError('ERR_PROOF',
      `proof root mismatch: computed ${computed.toString('hex')} != expected ${root}`,
      { computedRoot: computed.toString('hex'), expectedRoot: root });
  }
  return { root };
}

module.exports = {
  DEFAULT_BLOCK_SIZE,
  EvidenceError,
  sha256,
  leafHash,
  nodeHash,
  emptyRoot,
  chunkBuffer,
  leafHashesOf,
  merkleRootFromLeafHashes,
  buildIndex,
  validateIndex,
  scanRoot,
  localizeAgainstIndex,
  buildProof,
  makeProof,
  checkProof,
};
