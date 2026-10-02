'use strict';

const fs = require('node:fs');
const {
  GENESIS_PREV,
  encodeBlock,
  decodeBlockAt,
  encodePayload,
  decodePayload,
  blockHash,
} = require('./format');

const INDEX_SPAN = 8;

class TxLogError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.blocks = [];
    this.index = new Map();
    this.tipHash = Buffer.from(GENESIS_PREV);
    this.nextSeq = 1;
    this._load();
  }

  _load() {
    let buf;
    try {
      buf = fs.readFileSync(this.filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    let offset = 0;
    while (offset < buf.length) {
      const r = decodeBlockAt(buf, offset);
      if (!r.ok) {
        throw new TxLogError(
          r.reason,
          r.reason === 'INCOMPLETE'
            ? `incomplete block at offset ${offset}`
            : `corrupt block at offset ${offset}: ${r.detail || ''}`,
          { offset }
        );
      }
      if (r.seq !== this.nextSeq) {
        throw new TxLogError('CORRUPT', `unexpected seq ${r.seq} at offset ${offset}, expected ${this.nextSeq}`, { offset });
      }
      if (!r.prevHash.equals(this.tipHash)) {
        throw new TxLogError('CORRUPT', `broken hash chain at offset ${offset}`, { offset });
      }
      const decoded = decodePayload(r.payload);
      if (!decoded.ok) {
        throw new TxLogError('CORRUPT', `bad payload at offset ${offset}: ${decoded.detail}`, { offset });
      }
      this._admit({ offset, seq: r.seq, prevHash: r.prevHash, hash: r.hash, records: decoded.records, bytesLen: r.nextOffset - offset });
      offset = r.nextOffset;
    }
  }

  _admit(block) {
    this.blocks.push(block);
    if (block.seq === 1 || block.seq % INDEX_SPAN === 0) {
      this.index.set(block.seq, block.offset);
    }
    this.tipHash = block.hash;
    this.nextSeq = block.seq + 1;
  }

  _checkFork(prevHash, seq, hash) {
    if (this.blocks.length === 0) {
      if (seq !== 1) throw new TxLogError('CORRUPT', `unexpected first seq ${seq}`);
      return;
    }
    if (!prevHash.equals(this.tipHash)) {
      const samePrev = this.blocks.filter((b) => b.prevHash.equals(prevHash));
      if (samePrev.some((b) => b.seq !== seq || !b.hash.equals(hash))) {
        throw new TxLogError(
          'FORK',
          `fork detected: incoming seq ${seq} conflicts with existing block(s) [${samePrev.map((b) => b.seq).join(', ')}] sharing the same prevHash; refusing to auto-select`
        );
      }
      throw new TxLogError('CORRUPT', 'prevHash does not match chain tip');
    }
    if (seq !== this.nextSeq) {
      throw new TxLogError('CORRUPT', `unexpected seq ${seq}, expected ${this.nextSeq}`);
    }
  }

  append(records) {
    return this.commitBlock({ seq: this.nextSeq, prevHash: this.tipHash.toString('hex'), records });
  }

  commitBlock({ seq, prevHash, records }) {
    const prev = Buffer.isBuffer(prevHash) ? prevHash : Buffer.from(prevHash, 'hex');
    const payload = encodePayload(records);
    const { bytes, header } = encodeBlock({ seq, prevHash: prev, payload });
    const hash = blockHash(header, payload);
    this._checkFork(prev, seq, hash);
    fs.appendFileSync(this.filePath, bytes);
    const offset = this.blocks.length === 0
      ? 0
      : this.blocks[this.blocks.length - 1].offset + this.blocks[this.blocks.length - 1].bytesLen;
    this._admit({ offset, seq, prevHash: prev, hash, records, bytesLen: bytes.length });
    return { seq, hash: hash.toString('hex') };
  }

  readRange(fromSeq, toSeq) {
    if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq < 1 || toSeq < fromSeq) {
      throw new TxLogError('USAGE', `invalid range ${fromSeq}..${toSeq}`);
    }
    if (toSeq > this.blocks.length) {
      throw new TxLogError('CORRUPT', `range end ${toSeq} beyond confirmed chain length ${this.blocks.length}`);
    }
    let coveredFrom = 1;
    for (const s of this.index.keys()) {
      if (s <= fromSeq && s > coveredFrom) coveredFrom = s;
    }
    const backfill = [];
    for (let s = coveredFrom; s < fromSeq; s++) backfill.push(this.blocks[s - 1]);
    const indexed = [];
    for (let s = fromSeq; s <= toSeq; s++) indexed.push(this.blocks[s - 1]);
    return { backfill, indexed, coveredFrom };
  }

  verify() {
    const fresh = new Store(this.filePath);
    return { blocks: fresh.blocks.length, tip: fresh.tipHash.toString('hex') };
  }
}

module.exports = { Store, TxLogError, INDEX_SPAN };
