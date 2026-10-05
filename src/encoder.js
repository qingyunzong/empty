'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { encodeBlock } = require('./format');
const { QGError } = require('./errors');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Atomic file replace: write to a temp file in the same directory, then rename.
function writeAtomic(filePath, data) {
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function validateRecords(records, knownLots) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new QGError('E_FORMAT', 'records must be a non-empty array');
  }
  const seen = new Set(knownLots);
  for (const r of records) {
    if (!r || typeof r.lot !== 'string' || r.lot.length === 0) {
      throw new QGError('E_FORMAT', 'every record needs a non-empty string "lot"');
    }
    if (!Array.isArray(r.parents)) {
      throw new QGError('E_FORMAT', `record ${r.lot}: "parents" must be an array`);
    }
    if (typeof r.op !== 'string' || typeof r.result !== 'string') {
      throw new QGError('E_FORMAT', `record ${r.lot}: "op" and "result" must be strings`);
    }
    if (seen.has(r.lot)) {
      throw new QGError('E_FORMAT', `duplicate lot "${r.lot}"`);
    }
    seen.add(r.lot);
  }
  // Parents must resolve to records already known or present in this batch.
  for (const r of records) {
    for (const p of r.parents) {
      if (!seen.has(p)) {
        throw new QGError('E_FORMAT', `record ${r.lot}: unknown parent lot "${p}"`);
      }
    }
  }
}

function chunk(records, size) {
  const blocks = [];
  for (let i = 0; i < records.length; i += size) {
    blocks.push(records.slice(i, i + size));
  }
  return blocks;
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Appends the given records as new blocks to the data file, then atomically
// rewrites manifest and index. When the data file does not exist yet a new
// genealogy is created.
function appendRecords({ records, dataPath, manifestPath, indexPath, blockSize = 8 }) {
  if (!Number.isInteger(blockSize) || blockSize < 1) {
    throw new QGError('E_FORMAT', 'blockSize must be a positive integer');
  }

  const fresh = !fs.existsSync(dataPath);
  const manifest = fresh
    ? { version: 1, blocks: [] }
    : loadJson(manifestPath, null);
  const index = fresh
    ? { version: 1, blocks: [], records: {}, children: {} }
    : loadJson(indexPath, null);
  if (!manifest || !index) {
    throw new QGError('E_INDEX', 'data file exists but manifest/index is missing');
  }
  if (manifest.blocks.length !== index.blocks.length) {
    throw new QGError('E_INDEX', 'manifest and index disagree on block count');
  }

  validateRecords(records, Object.keys(index.records));

  let offset = fresh ? 0 : fs.statSync(dataPath).size;
  const startId = manifest.blocks.length;
  let nextId = startId;
  const fd = fs.openSync(dataPath, fresh ? 'w' : 'a');
  try {
    for (const group of chunk(records, blockSize)) {
      const blockBuf = encodeBlock(nextId, group);
      fs.writeSync(fd, blockBuf);
      manifest.blocks.push(sha256(blockBuf));
      index.blocks.push({ id: nextId, offset, length: blockBuf.length });
      // Record offsets inside the payload.
      let recOffset = 0;
      for (const r of group) {
        index.records[r.lot] = { block: nextId, offset: recOffset };
        for (const p of r.parents) {
          (index.children[p] ||= []).push(r.lot);
        }
        recOffset += Buffer.byteLength(JSON.stringify(r) + '\n', 'utf8');
      }
      offset += blockBuf.length;
      nextId += 1;
    }
  } finally {
    fs.closeSync(fd);
  }

  writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));
  writeAtomic(indexPath, JSON.stringify(index, null, 2));

  return {
    blocksAdded: nextId - startId,
    totalBlocks: manifest.blocks.length,
    recordsAdded: records.length,
  };
}

function encode({ records, dataPath, manifestPath, indexPath, blockSize = 8 }) {
  for (const p of [dataPath, manifestPath, indexPath]) {
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  return appendRecords({ records, dataPath, manifestPath, indexPath, blockSize });
}

module.exports = { encode, appendRecords, writeAtomic, sha256 };
