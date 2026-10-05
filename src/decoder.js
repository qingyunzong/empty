'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { crc32 } = require('./crc32');
const { HEADER_LEN, parseHeader, parsePayload } = require('./format');
const { QGError } = require('./errors');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Incremental decoder: only the manifest and the index are read up front.
// Data blocks are loaded lazily, one at a time, exactly when a query needs a
// record stored in them. The whole data file is never read at once.
class Decoder {
  constructor({ dataPath, manifestPath, indexPath }) {
    this.dataPath = dataPath;
    this.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    this.index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (
      !Array.isArray(this.manifest.blocks) ||
      !Array.isArray(this.index.blocks) ||
      this.manifest.blocks.length !== this.index.blocks.length
    ) {
      throw new QGError('E_INDEX', 'index and manifest disagree on block count');
    }
    for (let i = 0; i < this.index.blocks.length; i++) {
      if (this.index.blocks[i].id !== i) {
        throw new QGError('E_INDEX', `index block entry ${i} is inconsistent`);
      }
    }
    this._fd = null;
    this._blockCache = new Map(); // blockId -> [{record, offset, bytes}]
  }

  _ensureFd() {
    if (this._fd === null) this._fd = fs.openSync(this.dataPath, 'r');
    return this._fd;
  }

  close() {
    if (this._fd !== null) {
      fs.closeSync(this._fd);
      this._fd = null;
    }
  }

  // Reads and verifies a single block. Throws:
  //   E_INDEX - the index location does not line up with a valid block
  //   E_CRC   - the block payload fails its CRC32 or the manifest hash
  readBlock(blockId) {
    if (this._blockCache.has(blockId)) return this._blockCache.get(blockId);
    const entry = this.index.blocks[blockId];
    if (!entry || entry.id !== blockId) {
      throw new QGError('E_INDEX', `no index entry for block ${blockId}`);
    }
    const buf = Buffer.alloc(entry.length);
    let got;
    try {
      got = fs.readSync(this._ensureFd(), buf, 0, entry.length, entry.offset);
    } catch (err) {
      throw new QGError('E_INDEX', `cannot read block ${blockId}: ${err.message}`);
    }
    if (got !== entry.length) {
      throw new QGError('E_INDEX', `block ${blockId} extends past end of file`);
    }
    const header = parseHeader(buf);
    if (!header || header.id !== blockId || header.payloadLen !== entry.length - HEADER_LEN) {
      throw new QGError('E_INDEX', `index location for block ${blockId} does not match file layout`);
    }
    const payload = buf.subarray(HEADER_LEN);
    if (crc32(payload) !== header.crc) {
      throw new QGError('E_CRC', `block ${blockId} payload failed CRC32 check`);
    }
    if (sha256(buf) !== this.manifest.blocks[blockId]) {
      throw new QGError('E_CRC', `block ${blockId} hash does not match manifest`);
    }
    const records = parsePayload(payload);
    this._blockCache.set(blockId, records);
    return records;
  }

  record(lot) {
    const loc = this.index.records[lot];
    if (!loc) throw new QGError('E_NOTFOUND', `unknown lot "${lot}"`);
    const records = this.readBlock(loc.block);
    const hit = records.find((r) => r.offset === loc.offset);
    if (!hit || hit.record.lot !== lot) {
      throw new QGError('E_INDEX', `index record offset for lot "${lot}" is inconsistent`);
    }
    return hit.record;
  }

  // Directed genealogy graph: edges run child -> parents.
  // Ancestors of `lot`, DFS pre-order, de-duplicated.
  ancestors(lot) {
    const out = [];
    const seen = new Set();
    const visit = (current) => {
      if (seen.has(current)) return;
      seen.add(current);
      out.push(current);
      for (const p of this.record(current).parents) visit(p);
    };
    visit(lot);
    return out;
  }

  // Descendants via the reverse (children) index; every visited record is
  // still loaded and verified, so corrupted blocks abort with E_CRC.
  descendants(lot) {
    if (!this.index.records[lot]) throw new QGError('E_NOTFOUND', `unknown lot "${lot}"`);
    const out = [];
    const seen = new Set();
    const visit = (current, fromChild) => {
      if (seen.has(current)) return;
      seen.add(current);
      const rec = this.record(current);
      if (fromChild !== null && !rec.parents.includes(fromChild)) {
        throw new QGError('E_INDEX', `children index inconsistent for lot "${current}"`);
      }
      out.push(current);
      for (const child of this.index.children[current] || []) visit(child, current);
    };
    visit(lot, null);
    return out;
  }

  // All simple paths from `from` to `to` along child -> parent edges.
  paths(from, to) {
    if (!this.index.records[from]) throw new QGError('E_NOTFOUND', `unknown lot "${from}"`);
    if (!this.index.records[to]) throw new QGError('E_NOTFOUND', `unknown lot "${to}"`);
    const found = [];
    const stack = [from];
    const onPath = new Set([from]);
    const dfs = (node) => {
      if (node === to) {
        found.push([...stack]);
        return;
      }
      for (const parent of this.record(node).parents) {
        if (onPath.has(parent)) continue;
        onPath.add(parent);
        stack.push(parent);
        dfs(parent);
        stack.pop();
        onPath.delete(parent);
      }
    };
    dfs(from);
    return found;
  }

  // Path certificate: for every step, the block id, the record offset inside
  // the block payload, the record hash and the block hash from the manifest,
  // plus boundary hashes and a manifest prefix commitment so the certificate
  // can be re-verified standalone, even after later appends.
  certificateForPath(pathLots) {
    const steps = pathLots.map((lot) => {
      const loc = this.index.records[lot];
      if (!loc) throw new QGError('E_NOTFOUND', `unknown lot "${lot}"`);
      const records = this.readBlock(loc.block);
      const hit = records.find((r) => r.offset === loc.offset);
      if (!hit || hit.record.lot !== lot) {
        throw new QGError('E_INDEX', `index record offset for lot "${lot}" is inconsistent`);
      }
      return {
        lot,
        block: loc.block,
        recordOffset: loc.offset,
        recordHash: sha256(hit.bytes),
        blockHash: this.manifest.blocks[loc.block],
      };
    });
    return {
      type: 'qg-path-cert',
      version: 1,
      from: pathLots[0],
      to: pathLots[pathLots.length - 1],
      path: [...pathLots],
      steps,
      boundary: {
        startHash: steps[0].recordHash,
        endHash: steps[steps.length - 1].recordHash,
      },
      manifestBlocks: this.manifest.blocks.length,
      manifestHash: sha256(Buffer.from(this.manifest.blocks.join('\n'), 'utf8')),
    };
  }

  pathsWithCertificates(from, to) {
    const paths = this.paths(from, to);
    return {
      paths,
      certificates: paths.map((p) => this.certificateForPath(p)),
    };
  }
}

module.exports = { Decoder };
