'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const GENESIS_HASH = '0'.repeat(64);

class EvlogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvlogError';
    this.code = code;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(str) {
  const buf = Buffer.from(str, 'utf8');
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function canonicalBody({ seq, prevHash, payload, committed }) {
  return JSON.stringify({ seq, prevHash, payload, committed });
}

function encodeBlock({ seq, prevHash, payload, committed }) {
  const body = canonicalBody({ seq, prevHash, payload, committed });
  const crc = crc32(body);
  return JSON.stringify({ seq, prevHash, payload, committed, crc });
}

function blockHash(line) {
  return sha256(line);
}

function checkpointPath(logPath) {
  return `${logPath}.checkpoint`;
}

function isValidShape(block) {
  return (
    block !== null &&
    typeof block === 'object' &&
    Number.isInteger(block.seq) &&
    block.seq >= 1 &&
    typeof block.prevHash === 'string' &&
    /^[0-9a-f]{64}$/.test(block.prevHash) &&
    typeof block.committed === 'boolean' &&
    'payload' in block &&
    typeof block.crc === 'string' &&
    /^[0-9a-f]{8}$/.test(block.crc)
  );
}

// Parses the log and validates the chain over the longest valid prefix.
// Never throws; inspection of `firstError` is left to the caller.
function readState(logPath) {
  const state = {
    blocks: [],
    tailSeq: 0,
    tailHash: GENESIS_HASH,
    committedSeq: 0,
    committedRoot: GENESIS_HASH,
    lastCommitIndex: -1,
    committedEndOffset: 0,
    validEndOffset: 0,
    size: 0,
    firstError: null,
  };
  if (!fs.existsSync(logPath)) return state;
  const text = fs.readFileSync(logPath, 'utf8');
  state.size = Buffer.byteLength(text, 'utf8');
  const lines = text.split('\n');
  let offset = 0;
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1;
    if (line === '' && i === lines.length - 1) break; // clean EOF
    if (i === lines.length - 1) {
      state.firstError = {
        kind: 'incomplete',
        code: 'ERR_CRC',
        message: `incomplete trailing block at offset ${lineStart} (torn write)`,
        offset: lineStart,
      };
      break;
    }
    let error = null;
    let block = null;
    try {
      block = JSON.parse(line);
    } catch {
      error = new EvlogError('ERR_CRC', `block ${expectedSeq}: unparseable`);
    }
    if (!error && !isValidShape(block)) {
      error = new EvlogError('ERR_CRC', `block ${expectedSeq}: malformed fields`);
    }
    if (!error && crc32(canonicalBody(block)) !== block.crc) {
      error = new EvlogError('ERR_CRC', `block ${block.seq}: crc mismatch`);
    }
    if (!error && block.seq !== expectedSeq) {
      error = new EvlogError('ERR_SEQ', `expected seq ${expectedSeq}, found ${block.seq}`);
    }
    if (!error && block.prevHash !== prevHash) {
      error = new EvlogError('ERR_FORK', `block ${block.seq}: prevHash does not link to previous block`);
    }
    if (error) {
      state.firstError = { kind: 'invalid', code: error.code, message: error.message, offset: lineStart };
      break;
    }
    const hash = blockHash(line);
    state.blocks.push({
      seq: block.seq,
      prevHash: block.prevHash,
      payload: block.payload,
      committed: block.committed,
      hash,
      offset: lineStart,
    });
    prevHash = hash;
    expectedSeq += 1;
    state.tailSeq = block.seq;
    state.tailHash = hash;
    state.validEndOffset = offset;
    if (block.committed) {
      state.committedSeq = block.seq;
      state.committedRoot = hash;
      state.lastCommitIndex = state.blocks.length - 1;
      state.committedEndOffset = offset;
    }
  }
  return state;
}

function writeCheckpoint(logPath, ckp) {
  const tmp = `${checkpointPath(logPath)}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify(ckp)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, checkpointPath(logPath));
}

// Returns { status: 'missing' | 'corrupt' | 'ok', value? }
function readCheckpoint(logPath) {
  let text;
  try {
    text = fs.readFileSync(checkpointPath(logPath), 'utf8');
  } catch {
    return { status: 'missing' };
  }
  try {
    const value = JSON.parse(text);
    if (
      value === null ||
      typeof value !== 'object' ||
      !Number.isInteger(value.lastSeq) ||
      value.lastSeq < 0 ||
      typeof value.root !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.root)
    ) {
      return { status: 'corrupt' };
    }
    return { status: 'ok', value };
  } catch {
    return { status: 'corrupt' };
  }
}

function ensureLog(logPath) {
  const fd = fs.openSync(logPath, 'a');
  fs.closeSync(fd);
}

function appendLine(logPath, line) {
  const fd = fs.openSync(logPath, 'a');
  try {
    fs.writeSync(fd, `${line}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

class Handle {
  constructor(logPath) {
    ensureLog(logPath);
    this.logPath = logPath;
    this.baseRoot = readState(logPath).committedRoot;
  }

  append(payload) {
    if (payload === null || payload === undefined) {
      throw new EvlogError('ERR_USAGE', 'payload must not be null');
    }
    const state = readState(this.logPath);
    const seq = state.tailSeq + 1;
    appendLine(this.logPath, encodeBlock({ seq, prevHash: state.tailHash, payload, committed: false }));
    return seq;
  }

  commit() {
    const state = readState(this.logPath);
    if (state.committedRoot !== this.baseRoot) {
      throw new EvlogError(
        'ERR_STALE_ROOT',
        `handle base root ${this.baseRoot} is stale; log root is ${state.committedRoot}`,
      );
    }
    if (state.tailSeq === state.committedSeq) {
      writeCheckpoint(this.logPath, { lastSeq: state.committedSeq, root: state.committedRoot });
      return { lastSeq: state.committedSeq, root: state.committedRoot };
    }
    const seq = state.tailSeq + 1;
    const line = encodeBlock({ seq, prevHash: state.tailHash, payload: null, committed: true });
    appendLine(this.logPath, line);
    const root = blockHash(line);
    writeCheckpoint(this.logPath, { lastSeq: seq, root });
    this.baseRoot = root;
    return { lastSeq: seq, root };
  }
}

function open(logPath) {
  return new Handle(logPath);
}

function recover(logPath) {
  ensureLog(logPath);
  const state = readState(logPath);
  if (state.firstError && state.firstError.kind === 'invalid' && state.lastCommitIndex === -1) {
    // A complete but invalid block with no commit protecting any prefix:
    // genuine corruption, not a torn tail. Refuse to guess.
    throw new EvlogError(state.firstError.code, state.firstError.message);
  }
  const fd = fs.openSync(logPath, 'r+');
  try {
    fs.ftruncateSync(fd, state.committedEndOffset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  writeCheckpoint(logPath, { lastSeq: state.committedSeq, root: state.committedRoot });
  return {
    lastSeq: state.committedSeq,
    root: state.committedRoot,
    truncatedBytes: state.size - state.committedEndOffset,
  };
}

function verify(logPath) {
  const state = readState(logPath);
  if (state.firstError) {
    throw new EvlogError(state.firstError.code, state.firstError.message);
  }
  const ckp = readCheckpoint(logPath);
  if (ckp.status === 'corrupt') {
    throw new EvlogError('ERR_CRC', 'checkpoint is corrupt');
  }
  if (
    ckp.status === 'ok' &&
    (ckp.value.lastSeq !== state.committedSeq || ckp.value.root !== state.committedRoot)
  ) {
    throw new EvlogError('ERR_FORK', 'checkpoint diverges from log committed root');
  }
  const entries = state.blocks.filter((b, i) => i <= state.lastCommitIndex && b.payload !== null).length;
  const pending = state.blocks.filter((b, i) => i > state.lastCommitIndex && b.payload !== null).length;
  return { ok: true, lastSeq: state.committedSeq, root: state.committedRoot, entries, pending };
}

function tail(logPath, n) {
  const state = readState(logPath);
  if (state.firstError) {
    throw new EvlogError(state.firstError.code, state.firstError.message);
  }
  const committed = state.blocks
    .filter((b, i) => i <= state.lastCommitIndex && b.payload !== null)
    .map((b) => ({ seq: b.seq, payload: b.payload }));
  if (n === undefined) return committed;
  return committed.slice(Math.max(0, committed.length - n));
}

module.exports = {
  GENESIS_HASH,
  EvlogError,
  open,
  recover,
  verify,
  tail,
  crc32,
  encodeBlock,
  blockHash,
  checkpointPath,
};
