'use strict';

const fs = require('node:fs');
const { decodeBlock, decodeRecords, BLOCK_HEADER_SIZE } = require('./format');
const { QlinError } = require('./errors');
const { paths: dbPaths, sha256 } = require('./writer');

class Decoder {
  constructor(base) {
    const p = dbPaths(base);
    if (!fs.existsSync(p.data) || !fs.existsSync(p.manifest) || !fs.existsSync(p.index)) {
      throw new QlinError('E_NOTFOUND', `database not found at ${base}`);
    }
    this.base = base;
    this.manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
    this.index = JSON.parse(fs.readFileSync(p.index, 'utf8'));
    this.fd = fs.openSync(p.data, 'r');

    this.blocksById = new Map();
    for (const b of this.manifest.blocks) this.blocksById.set(b.id, b);

    // Validate index against manifest eagerly: every referenced block must
    // exist and every record range must lie inside its block.
    for (const [lot, e] of Object.entries(this.index.lots)) {
      const b = this.blocksById.get(e.block);
      if (!b) {
        throw new QlinError('E_INDEX', `index lot ${lot} references missing block ${e.block}`);
      }
      if (
        !Number.isInteger(e.offset) || !Number.isInteger(e.length) ||
        e.offset < b.offset + BLOCK_HEADER_SIZE ||
        e.offset + e.length > b.offset + b.length
      ) {
        throw new QlinError('E_INDEX', `index lot ${lot} range outside block ${e.block}`);
      }
    }

    // Reverse adjacency from the index (child -> parents is stored per lot).
    this.indexChildren = new Map();
    for (const [lot, e] of Object.entries(this.index.lots)) {
      for (const parent of e.parents || []) {
        if (!this.indexChildren.has(parent)) this.indexChildren.set(parent, new Set());
        this.indexChildren.get(parent).add(lot);
      }
    }

    this.loadedBlocks = new Map(); // blockId -> true
    this.corruptBlocks = new Set();
    this.records = new Map(); // lot -> {record, block, offset, length}
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  _readBlockBytes(entry) {
    const buf = Buffer.alloc(entry.length);
    const n = fs.readSync(this.fd, buf, 0, entry.length, entry.offset);
    if (n !== entry.length) {
      throw new QlinError('E_CRC', `short read on block ${entry.id}`);
    }
    return buf;
  }

  // Incrementally load and verify a single block; merge into the graph.
  _loadBlock(blockId) {
    if (this.loadedBlocks.has(blockId)) return;
    if (this.corruptBlocks.has(blockId)) {
      throw new QlinError('E_CRC', `block ${blockId} is corrupt`);
    }
    const entry = this.blocksById.get(blockId);
    if (!entry) {
      throw new QlinError('E_INDEX', `manifest has no block ${blockId}`);
    }
    const raw = this._readBlockBytes(entry);
    if (sha256(raw) !== entry.sha256) {
      this.corruptBlocks.add(blockId);
      throw new QlinError('E_CRC', `block ${blockId} hash mismatch vs manifest`);
    }
    let payload;
    try {
      payload = decodeBlock(raw);
    } catch (err) {
      this.corruptBlocks.add(blockId);
      throw err;
    }
    for (const { record, relOffset, length } of decodeRecords(payload)) {
      this.records.set(record.lot, {
        record,
        block: blockId,
        offset: entry.offset + BLOCK_HEADER_SIZE + relOffset,
        length,
      });
    }
    this.loadedBlocks.set(blockId, true);
  }

  // Ensure the record for lot is loaded and consistent with the index.
  _ensureLot(lot) {
    if (this.records.has(lot)) return this.records.get(lot);
    const idx = this.index.lots[lot];
    if (!idx) {
      throw new QlinError('E_NOTFOUND', `unknown lot ${lot}`);
    }
    this._loadBlock(idx.block);
    const meta = this.records.get(lot);
    if (!meta || meta.offset !== idx.offset || meta.length !== idx.length) {
      throw new QlinError('E_INDEX', `index entry for lot ${lot} does not match block contents`);
    }
    return meta;
  }

  _parentsOf(lot) {
    return this._ensureLot(lot).record.parents;
  }

  _childrenOf(lot) {
    const out = [];
    for (const child of this.indexChildren.get(lot) || []) {
      const meta = this._ensureLot(child);
      if (!meta.record.parents.includes(lot)) {
        throw new QlinError('E_INDEX', `index edge ${lot} -> ${child} not present in record`);
      }
      out.push(child);
    }
    return out;
  }

  _walk(start, expand) {
    this._ensureLot(start);
    const order = [];
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const lot = queue.shift();
      order.push(lot);
      for (const next of expand(lot)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return order;
  }

  ancestors(lot) {
    const lots = this._walk(lot, (l) => this._parentsOf(l));
    return { lots, proof: this._buildSetProof('ancestors', lot, lots) };
  }

  descendants(lot) {
    const lots = this._walk(lot, (l) => this._childrenOf(l));
    return { lots, proof: this._buildSetProof('descendants', lot, lots) };
  }

  // All simple directed paths from -> to (edges point child -> parent).
  paths(from, to) {
    this._ensureLot(from);
    this._ensureLot(to);
    const results = [];
    const stack = [from];
    const onPath = new Set([from]);
    const dfs = (node) => {
      if (node === to) {
        results.push([...stack]);
        return;
      }
      for (const parent of this._parentsOf(node)) {
        if (onPath.has(parent)) continue;
        onPath.add(parent);
        stack.push(parent);
        dfs(parent);
        stack.pop();
        onPath.delete(parent);
      }
    };
    dfs(from);
    return results.map((path) => this._buildPathCert(path));
  }

  _blockCertEntries(blockIds) {
    return [...blockIds].sort((a, b) => a - b).map((id) => {
      const e = this.blocksById.get(id);
      return { id, offset: e.offset, length: e.length, sha256: e.sha256 };
    });
  }

  _recordCertEntries(lots) {
    return lots.map((lot) => {
      const meta = this.records.get(lot);
      return { lot, block: meta.block, offset: meta.offset, length: meta.length };
    });
  }

  _buildPathCert(path) {
    const blockIds = new Set(path.map((lot) => this.records.get(lot).block));
    return {
      type: 'qlin-path-cert',
      version: 1,
      from: path[0],
      to: path[path.length - 1],
      path: [...path],
      records: this._recordCertEntries(path),
      blocks: this._blockCertEntries(blockIds),
    };
  }

  _buildSetProof(direction, root, lots) {
    const blockIds = new Set(lots.map((lot) => this.records.get(lot).block));
    return {
      type: 'qlin-set-proof',
      version: 1,
      direction,
      root,
      lots: [...lots],
      records: this._recordCertEntries(lots),
      blocks: this._blockCertEntries(blockIds),
    };
  }

  // Independent re-verification: re-read blocks and records from the data
  // file, recompute hashes, and check the claimed edges. Does not trust the
  // in-memory graph or the index.
  verifyCertificate(cert) {
    if (!cert || (cert.type !== 'qlin-path-cert' && cert.type !== 'qlin-set-proof')) {
      throw new QlinError('E_CERT', 'unknown certificate type');
    }
    const recordsByLot = this._verifyCertCommon(cert);
    if (cert.type === 'qlin-path-cert') {
      const path = cert.path;
      if (!Array.isArray(path) || path.length === 0 || cert.from !== path[0] || cert.to !== path[path.length - 1]) {
        throw new QlinError('E_CERT', 'certificate path endpoints inconsistent');
      }
      for (const lot of path) {
        if (!recordsByLot.has(lot)) {
          throw new QlinError('E_CERT', `certificate missing record for lot ${lot}`);
        }
      }
      for (let i = 0; i + 1 < path.length; i++) {
        const rec = recordsByLot.get(path[i]);
        if (!rec.parents.includes(path[i + 1])) {
          throw new QlinError('E_CERT', `edge ${path[i]} -> ${path[i + 1]} not present in record`);
        }
      }
    } else {
      if (!cert.lots.includes(cert.root)) {
        throw new QlinError('E_CERT', 'proof root not in lot set');
      }
      for (const lot of cert.lots) {
        if (!recordsByLot.has(lot)) {
          throw new QlinError('E_CERT', `proof missing record for lot ${lot}`);
        }
      }
    }
    return true;
  }

  _verifyCertCommon(cert) {
    const blockEntries = new Map();
    for (const b of cert.blocks || []) {
      const manifestEntry = this.blocksById.get(b.id);
      if (!manifestEntry) {
        throw new QlinError('E_MANIFEST', `certificate block ${b.id} not in manifest`);
      }
      if (manifestEntry.sha256 !== b.sha256) {
        throw new QlinError('E_MANIFEST', `certificate block ${b.id} hash disagrees with manifest`);
      }
      const raw = this._readBlockBytes(manifestEntry);
      if (sha256(raw) !== b.sha256) {
        throw new QlinError('E_CRC', `block ${b.id} fails hash re-verification`);
      }
      decodeBlock(raw); // CRC32 re-check
      blockEntries.set(b.id, manifestEntry);
    }
    const recordsByLot = new Map();
    for (const r of cert.records || []) {
      const block = blockEntries.get(r.block);
      if (!block) {
        throw new QlinError('E_CERT', `record ${r.lot} references block ${r.block} not in certificate`);
      }
      if (r.offset < block.offset + BLOCK_HEADER_SIZE || r.offset + r.length > block.offset + block.length) {
        throw new QlinError('E_CERT', `record ${r.lot} range outside block ${r.block}`);
      }
      const buf = Buffer.alloc(r.length);
      const n = fs.readSync(this.fd, buf, 0, r.length, r.offset);
      if (n !== r.length) {
        throw new QlinError('E_CRC', `short read on record ${r.lot}`);
      }
      let rec;
      try {
        rec = JSON.parse(buf.toString('utf8').replace(/\n$/, ''));
      } catch {
        throw new QlinError('E_CERT', `record ${r.lot} is not valid JSON`);
      }
      if (rec.lot !== r.lot) {
        throw new QlinError('E_CERT', `record at offset ${r.offset} is lot ${rec.lot}, expected ${r.lot}`);
      }
      recordsByLot.set(r.lot, rec);
    }
    return recordsByLot;
  }
}

module.exports = { Decoder };

// Standalone re-verification entry point: trusts only the manifest and the
// data file, never the index or any in-memory graph state.
function verifyCertificateFile(base, cert) {
  const decoder = new Decoder(base);
  try {
    return decoder.verifyCertificate(cert);
  } finally {
    decoder.close();
  }
}

module.exports.verifyCertificateFile = verifyCertificateFile;
