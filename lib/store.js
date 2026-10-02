'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { crc32 } = require('./crc32');

const SUPER_MAGIC = 'AUDLGBK1';
const CHUNK_MAGIC = 0x314b4843; // 'CHK1'
const HEADER_LEN = 60; // magic4 index4 prevHash32 eventCount4 payloadLen4 endOffset8 crc4
const VERSION = 1;
const DEFAULT_SLOT_SIZE = 4096;

class CorruptionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CorruptionError';
    if (details !== undefined) this.details = details;
  }
}

const ledgerFile = (dir) => path.join(dir, 'ledger.dat');
const indexFile = (dir) => path.join(dir, 'index.json');
const stateFile = (dir) => path.join(dir, 'state.json');
const quarantineFile = (dir) => path.join(dir, 'quarantine.json');

function isAllZero(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function superblock(slotSize) {
  const sb = Buffer.alloc(slotSize);
  sb.write(SUPER_MAGIC, 0, 'utf8');
  sb.writeUInt32LE(VERSION, 8);
  sb.writeUInt32LE(slotSize, 12);
  return sb;
}

function ensureStore(dir, slotSize = DEFAULT_SLOT_SIZE) {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(ledgerFile(dir))) {
    if (!Number.isInteger(slotSize) || slotSize < 128) {
      throw new Error(`invalid slot size: ${slotSize}`);
    }
    fs.writeFileSync(ledgerFile(dir), superblock(slotSize));
  }
  return readSuper(dir);
}

function readSuper(dir) {
  if (!fs.existsSync(ledgerFile(dir))) {
    throw new CorruptionError(`store not found at ${dir}`);
  }
  const fd = fs.openSync(ledgerFile(dir), 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('utf8', 0, 8) !== SUPER_MAGIC) {
      throw new CorruptionError('bad superblock magic');
    }
    return { slotSize: head.readUInt32LE(12) };
  } finally {
    fs.closeSync(fd);
  }
}

function encodePayload(events) {
  return Buffer.from(events.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
}

function buildChunkSlot({ slotSize, index, prevHash, events, offset }) {
  const payload = encodePayload(events);
  if (HEADER_LEN + payload.length > slotSize) {
    throw new Error('payload does not fit in slot');
  }
  const slot = Buffer.alloc(slotSize);
  slot.writeUInt32LE(CHUNK_MAGIC, 0);
  slot.writeUInt32LE(index, 4);
  prevHash.copy(slot, 8);
  slot.writeUInt32LE(events.length, 40);
  slot.writeUInt32LE(payload.length, 44);
  slot.writeBigUInt64LE(BigInt(offset + slotSize), 48);
  payload.copy(slot, HEADER_LEN);
  const crc = crc32(payload, crc32(slot.subarray(0, 56)));
  slot.writeUInt32LE(crc, 56);
  return slot;
}

function parseSlot(slotBuf) {
  if (slotBuf.readUInt32LE(0) !== CHUNK_MAGIC) throw new Error('bad chunk magic');
  const index = slotBuf.readUInt32LE(4);
  const prevHash = Buffer.from(slotBuf.subarray(8, 40));
  const eventCount = slotBuf.readUInt32LE(40);
  const payloadLen = slotBuf.readUInt32LE(44);
  const endOffset = slotBuf.readBigUInt64LE(48);
  const crc = slotBuf.readUInt32LE(56);
  if (HEADER_LEN + payloadLen > slotBuf.length) {
    throw new Error('payload length out of bounds');
  }
  const payloadRaw = Buffer.from(slotBuf.subarray(HEADER_LEN, HEADER_LEN + payloadLen));
  return { index, prevHash, eventCount, payloadLen, endOffset, crc, payloadRaw };
}

function decodeEvents(parsed) {
  if (parsed.payloadLen === 0) {
    if (parsed.eventCount !== 0) throw new Error('event count mismatch');
    return [];
  }
  const lines = parsed.payloadRaw.toString('utf8').split('\n');
  const events = lines.map((l) => JSON.parse(l));
  if (events.length !== parsed.eventCount) throw new Error('event count mismatch');
  return events;
}

function verifySlot(slotBuf, parsed) {
  return parsed.crc === crc32(parsed.payloadRaw, crc32(slotBuf.subarray(0, 56)));
}

// Scan the whole ledger slot by slot. Fixed slots make scanning robust even
// when a chunk header is garbled. The first failing chunk is quarantined;
// every later chunk is pending (chain broken) regardless of its own CRC.
function scanStore(dir) {
  const { slotSize } = readSuper(dir);
  const buf = fs.readFileSync(ledgerFile(dir));
  const totalSlots = Math.floor(buf.length / slotSize);
  const remainder = buf.length % slotSize;
  const chunks = [];
  let prevHash = Buffer.alloc(32);
  let broken = false;
  let zeroTailSlots = 0;
  let partialZeroTail = false;
  let garbageTail = false;

  for (let slot = 1; slot < totalSlots; slot++) {
    const slotBuf = buf.subarray(slot * slotSize, (slot + 1) * slotSize);
    if (!broken && isAllZero(slotBuf)) {
      zeroTailSlots = totalSlots - slot;
      for (let s = slot; s < totalSlots; s++) {
        if (!isAllZero(buf.subarray(s * slotSize, (s + 1) * slotSize))) garbageTail = true;
      }
      break;
    }
    let parsed = null;
    let events = null;
    let error = null;
    try {
      parsed = parseSlot(slotBuf);
      events = decodeEvents(parsed);
    } catch (e) {
      error = e.message;
    }
    const ok =
      !broken &&
      parsed !== null &&
      events !== null &&
      parsed.index === slot - 1 &&
      Number(parsed.endOffset) === (slot + 1) * slotSize &&
      parsed.prevHash.equals(prevHash) &&
      verifySlot(slotBuf, parsed);

    if (ok) {
      chunks.push({
        index: slot - 1,
        offset: slot * slotSize,
        endOffset: (slot + 1) * slotSize,
        eventCount: parsed.eventCount,
        status: 'confirmed',
        events,
      });
      prevHash = sha256(slotBuf);
    } else {
      const status = broken ? 'pending' : 'quarantined';
      chunks.push({
        index: slot - 1,
        offset: slot * slotSize,
        endOffset: (slot + 1) * slotSize,
        eventCount: parsed ? parsed.eventCount : null,
        status,
        events: events || undefined,
        error: error || (parsed ? 'crc or chain mismatch' : 'unparseable header'),
      });
      broken = true;
    }
  }

  if (remainder > 0) {
    const rem = buf.subarray(totalSlots * slotSize);
    if (isAllZero(rem)) partialZeroTail = true;
    else garbageTail = true;
  }

  return {
    slotSize,
    chunks,
    confirmed: chunks.filter((c) => c.status === 'confirmed'),
    quarantined: chunks.filter((c) => c.status === 'quarantined'),
    pending: chunks.filter((c) => c.status === 'pending'),
    zeroTailSlots,
    partialZeroTail,
    garbageTail,
  };
}

// Read and fully verify a single chunk by index (used by find via the index).
function readChunk(dir, chunkIndex) {
  const { slotSize } = readSuper(dir);
  const fd = fs.openSync(ledgerFile(dir), 'r');
  try {
    const slotBuf = Buffer.alloc(slotSize);
    const offset = (chunkIndex + 1) * slotSize;
    const n = fs.readSync(fd, slotBuf, 0, slotSize, offset);
    if (n < slotSize) throw new CorruptionError(`chunk ${chunkIndex} beyond end of ledger`);
    let parsed;
    let events;
    try {
      parsed = parseSlot(slotBuf);
      events = decodeEvents(parsed);
    } catch (e) {
      throw new CorruptionError(`chunk ${chunkIndex} unparseable: ${e.message}`);
    }
    if (parsed.index !== chunkIndex || !verifySlot(slotBuf, parsed)) {
      throw new CorruptionError(`chunk ${chunkIndex} failed crc verification`);
    }
    return { index: chunkIndex, offset, endOffset: offset + slotSize, events };
  } finally {
    fs.closeSync(fd);
  }
}

function packEvents(slotSize, events) {
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const ev of events) {
    const line = Buffer.byteLength(JSON.stringify(ev), 'utf8');
    if (HEADER_LEN + line > slotSize) {
      const err = new Error(`event ${ev.tx || ''} too large for slot size ${slotSize}`);
      err.name = 'BusinessError';
      throw err;
    }
    const next = curLen === 0 ? line : curLen + 1 + line;
    if (HEADER_LEN + next > slotSize) {
      chunks.push(cur);
      cur = [ev];
      curLen = line;
    } else {
      cur.push(ev);
      curLen = next;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

function writeStore(dir, slotSize, chunkEvents) {
  const parts = [superblock(slotSize)];
  let prevHash = Buffer.alloc(32);
  chunkEvents.forEach((events, i) => {
    const slot = buildChunkSlot({
      slotSize,
      index: i,
      prevHash,
      events,
      offset: (i + 1) * slotSize,
    });
    prevHash = sha256(slot);
    parts.push(slot);
  });
  fs.writeFileSync(ledgerFile(dir), Buffer.concat(parts));
}

function truncateTo(dir, byteLength) {
  fs.truncateSync(ledgerFile(dir), byteLength);
}

module.exports = {
  CorruptionError,
  DEFAULT_SLOT_SIZE,
  HEADER_LEN,
  ledgerFile,
  indexFile,
  stateFile,
  quarantineFile,
  ensureStore,
  readSuper,
  scanStore,
  readChunk,
  packEvents,
  writeStore,
  truncateTo,
};
