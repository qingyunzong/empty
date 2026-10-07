// Pack reader.
//
// IncrementalDecoder consumes the pack as a byte stream and emits one event
// per block as soon as that block is complete. Incomplete trailing bytes are
// buffered, so a multi-byte UTF-8 character may be split across two pushed
// chunks (or sit at a block boundary) without producing mojibake or dropped
// characters: strings are only decoded once their full byte sequence has
// arrived inside a complete, CRC-verified block.
//
// decodePack resolves record references after the whole stream was seen, so
// a damaged old dictionary only poisons the records bound to it.

import fs from 'node:fs';
import {
  BLOCK_TYPE,
  FILE_HEADER_SIZE,
  BLOCK_HEADER_SIZE,
  BLOCK_CRC_SIZE,
  TRAILER_SIZE,
  INDEX_MAGIC,
  checkFileHeader,
  parseBlock,
  parseIndex,
  parseTrailer,
} from './format.js';
import { decodeDictionaryPayload, decodeRecordsPayload } from './dictionary.js';
import { packPath } from './manifest.js';
import { PackError, E_DICT, E_CRC, E_DICTREF, E_FORMAT } from './errors.js';

export class IncrementalDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.headerSeen = false;
    this.indexMode = false;
    this.blockIndex = 0;
    this.offset = 0; // absolute offset of buffer[0] in the stream
  }

  // Returns the events produced by this chunk.
  push(chunk) {
    const events = [];
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    if (this.indexMode) return events;

    if (!this.headerSeen) {
      if (this.buffer.length < FILE_HEADER_SIZE) return events;
      try {
        checkFileHeader(this.buffer.subarray(0, FILE_HEADER_SIZE));
        events.push({ type: 'header', version: 1 });
      } catch (err) {
        events.push({ type: 'error', code: err.code, message: err.message, offset: 0 });
      }
      this.#consume(FILE_HEADER_SIZE);
      this.headerSeen = true;
    }

    for (;;) {
      if (this.buffer.length >= 4 && this.buffer.subarray(0, 4).equals(INDEX_MAGIC)) {
        this.indexMode = true; // rest of the stream is index + trailer
        break;
      }
      if (this.buffer.length < BLOCK_HEADER_SIZE) break;
      const payloadLength = this.buffer.readUInt32LE(5);
      const total = BLOCK_HEADER_SIZE + payloadLength + BLOCK_CRC_SIZE;
      if (this.buffer.length < total) break; // wait for the rest of the block
      const raw = this.buffer.subarray(0, total);
      const offset = this.offset;
      const index = this.blockIndex++;
      this.#consume(total);
      events.push(...this.#blockEvents(raw, index, offset));
    }
    return events;
  }

  #consume(n) {
    this.buffer = this.buffer.subarray(n);
    this.offset += n;
  }

  #blockEvents(raw, blockIndex, offset) {
    let parsed;
    try {
      parsed = parseBlock(Buffer.from(raw));
    } catch (err) {
      return [{ type: 'error', code: err.code, message: err.message, blockIndex, offset }];
    }
    const { type, version, payload, crcOk } = parsed;
    const base = { blockIndex, offset, version };
    if (type === BLOCK_TYPE.DICT) {
      if (!crcOk) {
        return [{ type: 'error', code: E_DICT, message: `dictionary block v${version} crc mismatch`, ...base }];
      }
      try {
        const dict = decodeDictionaryPayload(Buffer.from(payload), version);
        return [{ type: 'dictionary', dict, ...base }];
      } catch (err) {
        return [{ type: 'error', code: E_DICT, message: err.message, ...base }];
      }
    }
    if (type === BLOCK_TYPE.RECORDS) {
      if (!crcOk) {
        return [{ type: 'error', code: E_CRC, message: `record block (dict v${version}) crc mismatch`, ...base }];
      }
      try {
        const { refs } = decodeRecordsPayload(Buffer.from(payload), version);
        return [{ type: 'records', dictVersion: version, refs, ...base }];
      } catch (err) {
        return [{ type: 'error', code: E_CRC, message: err.message, ...base }];
      }
    }
    return [{ type: 'error', code: E_FORMAT, message: `unknown block type ${type}`, ...base }];
  }

  // Flush. Returns trailing events; emits the random-access index last.
  end() {
    const events = [];
    if (!this.headerSeen) {
      events.push({ type: 'error', code: E_FORMAT, message: 'empty stream', offset: 0 });
      this.buffer = Buffer.alloc(0);
      return events;
    }
    if (!this.indexMode) {
      if (this.buffer.length !== 0) {
        events.push({ type: 'error', code: E_FORMAT, message: 'truncated stream', offset: this.offset });
      }
      return events;
    }
    // buffer holds index + trailer
    if (this.buffer.length < TRAILER_SIZE) {
      events.push({ type: 'error', code: E_FORMAT, message: 'truncated index', offset: this.offset });
      return events;
    }
    try {
      const trailer = this.buffer.subarray(this.buffer.length - TRAILER_SIZE);
      const { indexOffset } = parseTrailer(trailer);
      if (indexOffset !== this.offset) {
        throw new PackError(E_FORMAT, 'index offset mismatch');
      }
      const entries = parseIndex(this.buffer.subarray(0, this.buffer.length - TRAILER_SIZE));
      events.push({ type: 'index', entries });
    } catch (err) {
      events.push({ type: 'error', code: err.code, message: err.message, offset: this.offset });
    }
    this.buffer = Buffer.alloc(0);
    return events;
  }
}

// Feeds `buf` through an IncrementalDecoder in `chunkSize`-sized pieces
// (default: single shot). Returns all events in order.
export function decodeBuffer(buf, chunkSize = buf.length || 1) {
  const decoder = new IncrementalDecoder();
  const events = [];
  for (let off = 0; off < buf.length; off += chunkSize) {
    events.push(...decoder.push(buf.subarray(off, Math.min(off + chunkSize, buf.length))));
  }
  events.push(...decoder.end());
  return events;
}

// Assembles decoder events into the final result. Resolution happens after
// all events were seen, so block order does not matter and a corrupt old
// dictionary only affects the records bound to it.
export function collect(events) {
  const dictionaries = new Map();
  const corruptDictVersions = new Set();
  const pendingRecordBlocks = [];
  const errors = [];
  let index = null;

  for (const ev of events) {
    switch (ev.type) {
      case 'dictionary':
        if (dictionaries.has(ev.dict.version)) {
          errors.push({ code: E_DICT, message: `duplicate dictionary v${ev.dict.version}`, blockIndex: ev.blockIndex, offset: ev.offset });
          corruptDictVersions.add(ev.dict.version);
        } else {
          dictionaries.set(ev.dict.version, ev.dict);
        }
        break;
      case 'records':
        pendingRecordBlocks.push(ev);
        break;
      case 'index':
        index = ev.entries;
        break;
      case 'error': {
        const { type, ...rest } = ev;
        errors.push(rest);
        if (rest.code === E_DICT && rest.version !== undefined) {
          corruptDictVersions.add(rest.version);
        }
        break;
      }
      default:
        break;
    }
  }

  const labels = [];
  for (const block of pendingRecordBlocks) {
    const { dictVersion, refs, blockIndex, offset } = block;
    if (corruptDictVersions.has(dictVersion)) {
      errors.push({ code: E_DICT, message: `record block depends on corrupt dictionary v${dictVersion}`, blockIndex, offset, dictVersion });
      continue;
    }
    const dict = dictionaries.get(dictVersion);
    if (!dict) {
      errors.push({ code: E_DICTREF, message: `record block references unknown dictionary v${dictVersion}`, blockIndex, offset, dictVersion });
      continue;
    }
    refs.forEach((ref, recordIndex) => {
      const resolved = resolveRef(dict, ref);
      if (resolved.error) {
        errors.push({ code: E_DICTREF, message: resolved.error, blockIndex, offset, dictVersion, recordIndex });
      } else {
        labels.push({ ...resolved.label, dictVersion });
      }
    });
  }

  return { labels, errors, dictionaries, index };
}

function resolveRef(dict, ref) {
  const out = {};
  for (const [field, id] of [['gtin', ref.gtinId], ['batch', ref.batchId], ['workstation', ref.workstationId]]) {
    const entry = dict.entryAt(id);
    if (!entry) {
      return { error: `unknown ${field} id ${id} in dictionary v${dict.version}` };
    }
    if (entry.field !== field) {
      return { error: `${field} id ${id} points at a ${entry.field} entry in dictionary v${dict.version}` };
    }
    out[field] = entry.value;
  }
  return { label: { ...out, serial: ref.serial, timestamp: ref.timestamp } };
}

export function decodePack(dir, { chunkSize } = {}) {
  const buf = fs.readFileSync(packPath(dir));
  return collect(decodeBuffer(buf, chunkSize ?? (buf.length || 1)));
}

// Normalized JSON view: fixed key order, NFC strings, ISO-8601 UTC time.
export function dumpLabels(dir, options) {
  const { labels, errors } = decodePack(dir, options);
  const normalized = labels.map((l) => ({
    gtin: l.gtin,
    batch: l.batch,
    serial: l.serial,
    workstation: l.workstation,
    timestamp: new Date(l.timestamp).toISOString(),
  }));
  return { labels: normalized, errors };
}

// --- Random access -------------------------------------------------------

export function readIndex(dir) {
  const file = packPath(dir);
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const trailerBuf = Buffer.alloc(TRAILER_SIZE);
    fs.readSync(fd, trailerBuf, 0, TRAILER_SIZE, size - TRAILER_SIZE);
    const { indexOffset } = parseTrailer(trailerBuf);
    const indexBuf = Buffer.alloc(size - TRAILER_SIZE - indexOffset);
    fs.readSync(fd, indexBuf, 0, indexBuf.length, indexOffset);
    return parseIndex(indexBuf);
  } finally {
    fs.closeSync(fd);
  }
}

export function readBlockAt(dir, entry) {
  const file = packPath(dir);
  const fd = fs.openSync(file, 'r');
  try {
    const raw = Buffer.alloc(entry.length);
    fs.readSync(fd, raw, 0, entry.length, entry.offset);
    return parseBlock(raw);
  } finally {
    fs.closeSync(fd);
  }
}

export function readDictionaryVersion(dir, version) {
  const entry = readIndex(dir).find((e) => e.type === BLOCK_TYPE.DICT && e.version === version);
  if (!entry) {
    throw new PackError(E_DICTREF, `dictionary v${version} not found`);
  }
  const block = readBlockAt(dir, entry);
  if (!block.crcOk) {
    throw new PackError(E_DICT, `dictionary v${version} crc mismatch`);
  }
  return decodeDictionaryPayload(block.payload, version);
}

// Decodes a single record block by index position, resolving its references
// against the dictionaries registered in the pack.
export function decodeRecordBlockAt(dir, blockPosition) {
  const entries = readIndex(dir);
  const entry = entries[blockPosition];
  if (!entry || entry.type !== BLOCK_TYPE.RECORDS) {
    throw new PackError(E_FORMAT, `block ${blockPosition} is not a record block`);
  }
  const block = readBlockAt(dir, entry);
  if (!block.crcOk) {
    throw new PackError(E_CRC, `record block ${blockPosition} crc mismatch`);
  }
  const { refs } = decodeRecordsPayload(block.payload, entry.version);
  const dict = readDictionaryVersion(dir, entry.version);
  const labels = refs.map((ref, recordIndex) => {
    const resolved = resolveRef(dict, ref);
    if (resolved.error) {
      throw new PackError(E_DICTREF, resolved.error, { recordIndex });
    }
    return { ...resolved.label, dictVersion: entry.version };
  });
  return { dictVersion: entry.version, labels };
}
