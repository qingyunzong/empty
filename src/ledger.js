import fs from 'node:fs';
import { LedgerError } from './errors.js';
import {
  BLOCK_TYPE,
  encodeBlock,
  readBlockAt,
  readHeaderAt,
  hashBuffer,
  encodeManifest,
  parseManifest,
} from './format.js';
import { emptyState, applyEvent } from './state.js';

export const MANIFEST_CAPACITY = 8;

export class Ledger {
  constructor(path) {
    this.path = path;
    this.manifestPath = `${path}.manifest`;
    this.tmpManifestPath = `${path}.manifest.new`;
  }

  get exists() {
    return fs.existsSync(this.path);
  }

  ensureGenesis() {
    if (this.exists) return;
    const block = encodeBlock({
      type: BLOCK_TYPE.ANCHOR,
      startSeq: 0,
      endSeq: 0,
      prevOffset: null,
      prevHash: null,
      payload: { state: emptyState() },
    });
    fs.writeFileSync(this.path, block);
    const fd = fs.openSync(this.path, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.writeManifest([{ offset: 0, length: block.length, startSeq: 0, endSeq: 0, hash: hashBuffer(block) }]);
  }

  writeManifest(entries) {
    const buf = encodeManifest(entries);
    const fd = fs.openSync(this.tmpManifestPath, 'w');
    try {
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.tmpManifestPath, this.manifestPath);
  }

  loadManifest() {
    if (fs.existsSync(this.manifestPath)) {
      if (fs.existsSync(this.tmpManifestPath)) {
        try {
          fs.unlinkSync(this.tmpManifestPath);
        } catch {
          // best-effort cleanup of a stale temp manifest
        }
      }
      return parseManifest(fs.readFileSync(this.manifestPath));
    }
    if (fs.existsSync(this.tmpManifestPath)) {
      // crash after writing the temp manifest but before rename: it is complete, adopt it
      const manifest = parseManifest(fs.readFileSync(this.tmpManifestPath));
      fs.renameSync(this.tmpManifestPath, this.manifestPath);
      return manifest;
    }
    throw new LedgerError('MANIFEST_MISSING', `no manifest found for ${this.path}`, null);
  }

  readChainToAnchor() {
    const manifest = this.loadManifest();
    const entries = manifest.entries;
    const fd = fs.openSync(this.path, 'r');
    try {
      const chain = [];
      const seen = new Set();
      let index = entries.length - 1;
      let cursor = { offset: entries[index].offset, hash: entries[index].hash };
      while (true) {
        if (seen.has(cursor.offset)) {
          throw new LedgerError('CORRUPT_BLOCK', `cycle in block chain at offset ${cursor.offset}`, null);
        }
        seen.add(cursor.offset);
        const block = readBlockAt(fd, cursor.offset, cursor.hash);
        chain.unshift(block);
        if (block.type === BLOCK_TYPE.ANCHOR) return chain;
        if (index > 0 && entries[index - 1].offset === block.prevOffset) {
          if (!entries[index - 1].hash.equals(block.prevHash)) {
            throw new LedgerError('MANIFEST_CORRUPT', 'manifest entry hash does not match chain link', null);
          }
          index -= 1;
          cursor = { offset: entries[index].offset, hash: entries[index].hash };
        } else if (block.prevOffset != null) {
          cursor = { offset: block.prevOffset, hash: block.prevHash };
        } else {
          throw new LedgerError('NO_ANCHOR', 'reached genesis without an anchor block', null);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  computeState() {
    const chain = this.readChainToAnchor();
    const anchor = chain[0];
    const state = structuredClone(anchor.payload.state);
    for (const block of chain.slice(1)) {
      block.payload.events.forEach((event, i) => applyEvent(state, event, block.startSeq + i));
    }
    return { state, anchor, tip: chain[chain.length - 1], chain };
  }

  rebuildManifest(tipEntry, prevOffset, prevHash) {
    const entries = [tipEntry];
    const fd = fs.openSync(this.path, 'r');
    try {
      while (entries.length < MANIFEST_CAPACITY && prevOffset != null) {
        const block = readBlockAt(fd, prevOffset, prevHash);
        entries.unshift({
          offset: block.offset,
          length: block.length,
          startSeq: block.startSeq,
          endSeq: block.endSeq,
          hash: block.hash,
        });
        prevOffset = block.prevOffset;
        prevHash = block.prevHash;
      }
    } finally {
      fs.closeSync(fd);
    }
    this.writeManifest(entries);
  }

  appendBlock(type, startSeq, endSeq, tip, payload) {
    const offset = fs.statSync(this.path).size;
    const block = encodeBlock({
      type,
      startSeq,
      endSeq,
      prevOffset: tip.offset,
      prevHash: tip.hash,
      payload,
    });
    const fd = fs.openSync(this.path, 'a');
    try {
      fs.writeSync(fd, block);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const entry = { offset, length: block.length, startSeq, endSeq, hash: hashBuffer(block) };
    this.rebuildManifest(entry, tip.offset, tip.hash);
    return { ...entry, hashHex: entry.hash.toString('hex') };
  }

  appendEvents(events) {
    if (!Array.isArray(events) || events.length === 0) {
      throw new LedgerError('BAD_EVENT', 'append requires a non-empty event array', null);
    }
    this.ensureGenesis();
    const { state, tip } = this.computeState();
    const startSeq = tip.endSeq + 1;
    events.forEach((event, i) => applyEvent(state, event, startSeq + i));
    const endSeq = startSeq + events.length - 1;
    const entry = this.appendBlock(BLOCK_TYPE.DELTA, startSeq, endSeq, tip, { events });
    return { startSeq, endSeq, offset: entry.offset, hash: entry.hashHex };
  }

  snapshot() {
    this.ensureGenesis();
    const { state, tip } = this.computeState();
    const entry = this.appendBlock(BLOCK_TYPE.ANCHOR, tip.endSeq, tip.endSeq, tip, { state });
    return { seq: tip.endSeq, offset: entry.offset, hash: entry.hashHex };
  }

  tail(n) {
    if (!Number.isInteger(n) || n < 1) {
      throw new LedgerError('BAD_INPUT', 'n must be a positive integer', null);
    }
    const chain = this.readChainToAnchor();
    const anchor = chain[0];
    const events = [];
    for (const block of chain.slice(1)) {
      block.payload.events.forEach((event, i) => events.push({ seq: block.startSeq + i, event }));
    }
    const total = events.length;
    const count = Math.min(n, total);
    const fromIndex = total - count;
    const state = structuredClone(anchor.payload.state);
    for (let i = 0; i < fromIndex; i += 1) applyEvent(state, events[i].event, events[i].seq);
    const stateAtWindowStart = structuredClone(state);
    for (let i = fromIndex; i < total; i += 1) applyEvent(state, events[i].event, events[i].seq);
    const windowEvents = events.slice(fromIndex);
    return {
      anchor: { seq: anchor.startSeq, offset: anchor.offset, hash: anchor.hash.toString('hex') },
      window: {
        fromSeq: windowEvents.length ? windowEvents[0].seq : anchor.startSeq,
        toSeq: windowEvents.length ? windowEvents[windowEvents.length - 1].seq : anchor.startSeq,
        eventCount: windowEvents.length,
      },
      stateAtWindowStart,
      events: windowEvents,
      finalState: state,
      blocksRead: chain.length,
    };
  }

  verify() {
    if (!this.exists) {
      throw new LedgerError('IO_ERROR', `ledger file ${this.path} does not exist`, null);
    }
    const fd = fs.openSync(this.path, 'r');
    const size = fs.statSync(this.path).size;
    const blocks = [];
    let prev = null;
    let state = null;
    let anchors = 0;
    let eventCount = 0;
    let offset = 0;
    try {
      while (offset < size) {
        let block;
        try {
          block = readBlockAt(fd, offset, null);
        } catch (err) {
          if (err instanceof LedgerError && err.code === 'CRC_MISMATCH' && prev) {
            err.details = { validThroughSeq: prev.endSeq };
          }
          throw err;
        }
        const range = [block.startSeq, block.endSeq];
        if (prev) {
          if (block.prevOffset !== prev.offset || !block.prevHash.equals(prev.hash)) {
            throw new LedgerError('HASH_CHAIN_BROKEN', `block at offset ${offset} does not link to its predecessor`, range);
          }
        } else {
          if (block.prevOffset != null) {
            throw new LedgerError('HASH_CHAIN_BROKEN', 'genesis block must not have a predecessor', range);
          }
          if (block.type !== BLOCK_TYPE.ANCHOR || block.startSeq !== 0) {
            throw new LedgerError('SEQ_GAP', 'first block must be an anchor at seq 0', range);
          }
        }
        if (block.type === BLOCK_TYPE.DELTA) {
          const expected = prev ? prev.endSeq + 1 : 1;
          if (block.startSeq !== expected) {
            throw new LedgerError('SEQ_GAP', `expected start seq ${expected}, got ${block.startSeq}`, range);
          }
        } else {
          const expected = prev ? prev.endSeq : 0;
          if (block.startSeq !== expected) {
            throw new LedgerError('SEQ_GAP', `anchor expected at seq ${expected}, got ${block.startSeq}`, range);
          }
        }
        if (block.type === BLOCK_TYPE.ANCHOR) {
          state = structuredClone(block.payload.state);
          anchors += 1;
        } else {
          block.payload.events.forEach((event, i) => {
            applyEvent(state, event, block.startSeq + i);
            eventCount += 1;
          });
        }
        blocks.push(block);
        prev = block;
        offset += block.length;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (!prev) {
      throw new LedgerError('CORRUPT_BLOCK', 'ledger file is empty', null);
    }
    const manifest = this.loadManifest();
    const tailBlocks = blocks.slice(-manifest.entries.length);
    for (let i = 0; i < manifest.entries.length; i += 1) {
      const entry = manifest.entries[i];
      const block = tailBlocks[i];
      if (!block || entry.offset !== block.offset || !entry.hash.equals(block.hash)) {
        throw new LedgerError('MANIFEST_CORRUPT', 'manifest does not match the chain tip', null);
      }
    }
    return {
      blocks: blocks.length,
      anchors,
      events: eventCount,
      lastSeq: prev.endSeq,
      tipHash: prev.hash.toString('hex'),
      manifestEntries: manifest.entries.length,
    };
  }

  latestAnchor() {
    const manifest = this.loadManifest();
    const fd = fs.openSync(this.path, 'r');
    try {
      const seen = new Set();
      const corrupt = [];
      let cursor = manifest.entries[manifest.entries.length - 1];
      while (true) {
        if (seen.has(cursor.offset)) {
          throw new LedgerError('CORRUPT_BLOCK', `cycle in block chain at offset ${cursor.offset}`, null);
        }
        seen.add(cursor.offset);
        let block;
        try {
          block = readBlockAt(fd, cursor.offset, cursor.hash ?? null);
        } catch (err) {
          if (err instanceof LedgerError && err.code === 'CRC_MISMATCH') {
            const header = readHeaderAt(fd, cursor.offset);
            if (header.type === BLOCK_TYPE.ANCHOR) throw err;
            corrupt.push({ offset: cursor.offset, range: [header.startSeq, header.endSeq] });
            if (header.prevOffset == null) throw err;
            cursor = { offset: header.prevOffset, hash: header.prevHash };
            continue;
          }
          throw err;
        }
        if (block.type === BLOCK_TYPE.ANCHOR) {
          return {
            anchor: { seq: block.startSeq, offset: block.offset, hash: block.hash.toString('hex') },
            corrupt,
          };
        }
        if (block.prevOffset == null) {
          throw new LedgerError('NO_ANCHOR', 'no anchor block in chain', null);
        }
        cursor = { offset: block.prevOffset, hash: block.prevHash };
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}
