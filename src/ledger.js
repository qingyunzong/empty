import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { crc32 } from './crc32.js';
import { initialState, applyEvent } from './state.js';

export const DEFAULT_QUOTA = 1000000;
export const SNAPSHOT_EVERY = 4;

const MAGIC = 'FZBLK1';
const GENESIS = 'GENESIS';

export class CorruptionError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CorruptionError';
    this.detail = detail;
  }
}

function blockFileName(index) {
  return `${String(index).padStart(6, '0')}.blk`;
}

function snapFileName(index) {
  return `${String(index).padStart(6, '0')}.snap`;
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWrite(file, buf) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

export function blockHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function encodeBlock({ blockIndex, seqStart, events, prevHash }) {
  const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify(events), 'utf8'));
  const header = {
    magic: MAGIC,
    block: blockIndex,
    seqStart,
    seqEnd: seqStart + events.length - 1,
    prevHash,
    deltaLen: payload.length,
    crc32: crc32(payload),
  };
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), payload]);
}

export function decodeBlock(buf) {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) throw new Error('missing header line');
  let header;
  try {
    header = JSON.parse(buf.subarray(0, nl).toString('utf8'));
  } catch {
    throw new Error('unparseable header');
  }
  if (!header || header.magic !== MAGIC) throw new Error('bad magic');
  const payload = buf.subarray(nl + 1);
  if (payload.length !== header.deltaLen) {
    throw new Error(`length mismatch: header says ${header.deltaLen}, file has ${payload.length}`);
  }
  if (crc32(payload) !== header.crc32) throw new Error('crc32 mismatch');
  let events;
  try {
    events = JSON.parse(zlib.inflateRawSync(payload).toString('utf8'));
  } catch {
    throw new Error('undecodable payload');
  }
  if (!Array.isArray(events)) throw new Error('payload is not an event array');
  return { header, events };
}

export function scanBlocks(dir) {
  const blocksDir = path.join(dir, 'blocks');
  const valid = [];
  const stray = [];
  let corruptAt = null;
  let files = [];
  if (fs.existsSync(blocksDir)) files = fs.readdirSync(blocksDir).sort();
  let expectedIndex = 1;
  let expectedSeq = 1;
  let prevHash = GENESIS;
  for (const file of files) {
    const match = /^(\d{6})\.blk$/.exec(file);
    if (!match) {
      stray.push(file);
      continue;
    }
    if (corruptAt) {
      corruptAt.trailing.push(file);
      continue;
    }
    const index = Number(match[1]);
    const buf = fs.readFileSync(path.join(blocksDir, file));
    try {
      if (index !== expectedIndex) {
        throw new Error(`block index gap: expected ${expectedIndex}, got ${index}`);
      }
      const { header, events } = decodeBlock(buf);
      if (header.block !== index) throw new Error(`header block ${header.block} != file index ${index}`);
      if (header.seqStart !== expectedSeq) {
        throw new Error(`event seq gap: expected ${expectedSeq}, got ${header.seqStart}`);
      }
      if (header.seqEnd !== header.seqStart + events.length - 1) {
        throw new Error('seq range does not match event count');
      }
      if (header.prevHash !== prevHash) throw new Error('prevHash chain broken');
      events.forEach((ev, i) => {
        if (ev.seq !== header.seqStart + i) {
          throw new Error(`event seq mismatch at offset ${i}`);
        }
      });
      const hash = blockHash(buf);
      valid.push({ index, file, hash, seqStart: header.seqStart, seqEnd: header.seqEnd, events });
      prevHash = hash;
      expectedSeq = header.seqEnd + 1;
      expectedIndex += 1;
    } catch (err) {
      corruptAt = { file, index, reason: err.message, trailing: [] };
    }
  }
  return { valid, corruptAt, stray };
}

export function readMeta(dir) {
  const file = path.join(dir, 'meta.json');
  if (!fs.existsSync(file)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(meta.quota) || meta.quota <= 0) throw new Error('bad quota');
    return meta;
  } catch {
    throw new CorruptionError(`corrupted meta file: ${file}`);
  }
}

export function ensureMeta(dir, quota) {
  if (readMeta(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, 'meta.json'), Buffer.from(JSON.stringify({ quota }), 'utf8'));
}

function writeSnapshot(dir, asOfBlock, state, index) {
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  const body = JSON.stringify({ asOfBlock, state, index });
  const envelope = JSON.stringify({ crc32: crc32(Buffer.from(body, 'utf8')), body });
  atomicWrite(path.join(dir, 'snapshots', snapFileName(asOfBlock)), Buffer.from(envelope, 'utf8'));
}

function loadLatestSnapshot(dir, maxBlock) {
  const snapDir = path.join(dir, 'snapshots');
  if (!fs.existsSync(snapDir)) return null;
  const names = fs
    .readdirSync(snapDir)
    .filter((f) => /^(\d{6})\.snap$/.test(f) && Number(f.slice(0, 6)) <= maxBlock)
    .sort()
    .reverse();
  for (const name of names) {
    try {
      const envelope = JSON.parse(fs.readFileSync(path.join(snapDir, name), 'utf8'));
      if (crc32(Buffer.from(envelope.body, 'utf8')) !== envelope.crc32) continue;
      const snap = JSON.parse(envelope.body);
      if (snap.asOfBlock !== Number(name.slice(0, 6))) continue;
      return snap;
    } catch {
      // try an earlier snapshot
    }
  }
  return null;
}

function writeIndex(dir, index) {
  atomicWrite(path.join(dir, 'index.json'), Buffer.from(JSON.stringify(index), 'utf8'));
}

function readIndex(dir) {
  const file = path.join(dir, 'index.json');
  if (!fs.existsSync(file)) return null;
  try {
    const index = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!index || typeof index.tickets !== 'object') return null;
    return index;
  } catch {
    return null;
  }
}

function replayFrom(scan, state, index, startBlock) {
  for (const block of scan.valid) {
    if (block.index < startBlock) continue;
    for (const ev of block.events) {
      applyEvent(state, ev);
      if (ev.type === 'freeze') index.tickets[ev.ticketId] = block.index;
    }
  }
}

export function loadState(dir) {
  const meta = readMeta(dir);
  const quota = meta ? meta.quota : DEFAULT_QUOTA;
  const scan = scanBlocks(dir);
  if (scan.corruptAt) {
    throw new CorruptionError(
      `ledger corrupted at ${scan.corruptAt.file}: ${scan.corruptAt.reason}; run recover`,
      scan.corruptAt,
    );
  }
  const lastBlock = scan.valid.length ? scan.valid[scan.valid.length - 1].index : 0;
  const lastHash = scan.valid.length ? scan.valid[scan.valid.length - 1].hash : GENESIS;
  const snap = loadLatestSnapshot(dir, lastBlock);
  let state;
  let index;
  let startBlock;
  if (snap) {
    state = snap.state;
    index = snap.index;
    startBlock = snap.asOfBlock + 1;
  } else {
    state = initialState(quota);
    index = { tickets: {} };
    startBlock = 1;
  }
  replayFrom(scan, state, index, startBlock);
  return { state, index, lastBlock, lastHash, quota };
}

export function appendEvents(dir, events) {
  const loaded = loadState(dir);
  const blockIndex = loaded.lastBlock + 1;
  const seqStart = loaded.state.nextEventSeq;
  events.forEach((ev, i) => {
    ev.seq = seqStart + i;
  });
  const buf = encodeBlock({ blockIndex, seqStart, events, prevHash: loaded.lastHash });
  fs.mkdirSync(path.join(dir, 'blocks'), { recursive: true });
  atomicWrite(path.join(dir, 'blocks', blockFileName(blockIndex)), buf);
  for (const ev of events) {
    applyEvent(loaded.state, ev);
    if (ev.type === 'freeze') loaded.index.tickets[ev.ticketId] = blockIndex;
  }
  writeIndex(dir, loaded.index);
  if (blockIndex % SNAPSHOT_EVERY === 0) {
    writeSnapshot(dir, blockIndex, loaded.state, loaded.index);
  }
  return loaded;
}

export function decodeTicket(dir, ticketId) {
  const meta = readMeta(dir);
  const quota = meta ? meta.quota : DEFAULT_QUOTA;
  const scan = scanBlocks(dir);
  if (scan.corruptAt) {
    throw new CorruptionError(
      `ledger corrupted at ${scan.corruptAt.file}: ${scan.corruptAt.reason}; run recover`,
      scan.corruptAt,
    );
  }
  let index = readIndex(dir);
  if (!index || !(ticketId in index.tickets)) {
    const state = initialState(quota);
    index = { tickets: {} };
    replayFrom(scan, state, index, 1);
    fs.mkdirSync(dir, { recursive: true });
    writeIndex(dir, index);
  }
  const firstBlock = index.tickets[ticketId];
  if (firstBlock == null) return null;
  // Incremental decode: start from the snapshot preceding the ticket's first
  // block, then apply deltas from that point forward.
  const snap = loadLatestSnapshot(dir, firstBlock - 1);
  const state = snap ? snap.state : initialState(quota);
  const startBlock = snap ? snap.asOfBlock + 1 : 1;
  replayFrom(scan, state, { tickets: {} }, startBlock);
  return state.tickets[ticketId] ?? null;
}

export function recover(dir) {
  const meta = readMeta(dir);
  const quota = meta ? meta.quota : DEFAULT_QUOTA;
  const scan = scanBlocks(dir);
  const blocksDir = path.join(dir, 'blocks');
  const removedBlocks = [];
  if (scan.corruptAt) {
    for (const file of [scan.corruptAt.file, ...scan.corruptAt.trailing]) {
      fs.unlinkSync(path.join(blocksDir, file));
      removedBlocks.push(file);
    }
  }
  for (const file of scan.stray) {
    fs.unlinkSync(path.join(blocksDir, file));
    removedBlocks.push(file);
  }
  if (removedBlocks.length && fs.existsSync(blocksDir)) fsyncDir(blocksDir);
  // Rebuild state and index from the confirmed blocks only, ignoring any
  // stale snapshots, then persist a fresh snapshot and index.
  const state = initialState(quota);
  const index = { tickets: {} };
  replayFrom(scan, state, index, 1);
  const lastBlock = scan.valid.length ? scan.valid[scan.valid.length - 1].index : 0;
  const lastHash = scan.valid.length ? scan.valid[scan.valid.length - 1].hash : GENESIS;
  fs.mkdirSync(dir, { recursive: true });
  writeIndex(dir, index);
  writeSnapshot(dir, lastBlock, state, index);
  return {
    removedBlocks,
    lastBlock,
    lastHash,
    tickets: Object.keys(state.tickets).length,
    available: state.available,
  };
}
