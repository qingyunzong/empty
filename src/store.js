'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonical } = require('./canon');
const { crc32 } = require('./crc32');

function computeCrc32(chunk) {
  const payload = {};
  for (const k of Object.keys(chunk)) {
    if (k === 'hash' || k === 'crc32') continue;
    payload[k] = chunk[k];
  }
  return crc32(Buffer.from(canonical(payload), 'utf8'));
}

function computeHash(chunk) {
  const payload = {};
  for (const k of Object.keys(chunk)) {
    if (k === 'hash') continue;
    payload[k] = chunk[k];
  }
  return crypto.createHash('sha256').update(canonical(payload), 'utf8').digest('hex');
}

function buildChunk(fields) {
  const chunk = { version: 1, ...fields };
  chunk.crc32 = computeCrc32(chunk);
  chunk.hash = computeHash(chunk);
  return chunk;
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.chunksDir = path.join(dir, 'chunks');
    this.proposalsDir = path.join(dir, 'proposals');
    this.indexPath = path.join(dir, 'index.json');
    this.statePath = path.join(dir, 'state.json');
  }

  ensureDirs() {
    fs.mkdirSync(this.chunksDir, { recursive: true });
    fs.mkdirSync(this.proposalsDir, { recursive: true });
  }

  // --- proposals ---
  proposalPath(batchId) {
    return path.join(this.proposalsDir, encodeURIComponent(batchId) + '.json');
  }

  readProposal(batchId) {
    const p = this.proposalPath(batchId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  writeProposal(proposal) {
    this.ensureDirs();
    atomicWrite(this.proposalPath(proposal.batchId), JSON.stringify(proposal, null, 2));
  }

  // --- chunks ---
  chunkPath(hash) {
    return path.join(this.chunksDir, hash + '.json');
  }

  writeChunk(chunk) {
    this.ensureDirs();
    atomicWrite(this.chunkPath(chunk.hash), JSON.stringify(chunk, null, 2));
  }

  // Returns { chunks: Map<hash, chunk>, corrupt: [{file, reason}] }
  loadChunks() {
    const chunks = new Map();
    const corrupt = [];
    if (!fs.existsSync(this.chunksDir)) return { chunks, corrupt };
    for (const name of fs.readdirSync(this.chunksDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.chunksDir, name);
      let chunk;
      try {
        chunk = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        corrupt.push({ file: name, reason: 'unparseable JSON' });
        continue;
      }
      if (!chunk || typeof chunk !== 'object' || typeof chunk.hash !== 'string' ||
          typeof chunk.crc32 !== 'string') {
        corrupt.push({ file: name, reason: 'missing hash/crc32 fields' });
        continue;
      }
      if (computeCrc32(chunk) !== chunk.crc32) {
        corrupt.push({ file: name, reason: 'crc32 mismatch' });
        continue;
      }
      if (computeHash(chunk) !== chunk.hash) {
        corrupt.push({ file: name, reason: 'hash mismatch' });
        continue;
      }
      chunks.set(chunk.hash, chunk);
    }
    return { chunks, corrupt };
  }

  // --- index ---
  indexExists() {
    return fs.existsSync(this.indexPath);
  }

  loadIndex() {
    if (!this.indexExists()) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      return Array.isArray(data.entries) ? data.entries : [];
    } catch (e) {
      return [];
    }
  }

  writeIndex(entries) {
    this.ensureDirs();
    atomicWrite(this.indexPath, JSON.stringify({ entries }, null, 2));
  }

  // --- mutable state (rollback / correction markers, seq counter) ---
  loadState() {
    if (!fs.existsSync(this.statePath)) {
      return { rolledback: [], corrected: {}, seq: 0 };
    }
    const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    return {
      rolledback: Array.isArray(s.rolledback) ? s.rolledback : [],
      corrected: s.corrected && typeof s.corrected === 'object' ? s.corrected : {},
      seq: typeof s.seq === 'number' ? s.seq : 0,
    };
  }

  writeState(state) {
    this.ensureDirs();
    atomicWrite(this.statePath, JSON.stringify(state, null, 2));
  }
}

module.exports = { Store, buildChunk, computeCrc32, computeHash };
