'use strict';
/*
 * evlog: append-only compliance evidence log with crash recovery.
 *
 * On-disk format: a sequence of framed blocks.
 *   [4B magic "EVL1"][4B LE body length][JSON body][4B LE CRC32(magic|len|body)]
 *
 * Block kinds:
 *   data   {t:"d", seq, prevHash, payload}   written by append()
 *   commit {t:"c", seq, root}                written by commit(), seals pending data blocks
 *
 * Sidecar checkpoint file "<log>.ckpt": JSON {lastSeq, root} of the last commit.
 * The log is the source of truth; the checkpoint is a rebuildable hint.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');

const MAGIC = 'EVL1';
const GENESIS = '0'.repeat(64);

class EvlogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvlogError';
    this.code = code;
  }
}

/* ---------- CRC32 (IEEE 802.3) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function dataHash(o) {
  return sha256hex(Buffer.from(JSON.stringify({ seq: o.seq, prevHash: o.prevHash, payload: o.payload }), 'utf8'));
}

/* ---------- framing ---------- */
function encodeBlock(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.write(MAGIC, 0, 4, 'ascii');
  head.writeUInt32LE(body.length, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(crc32(Buffer.concat([head, body])), 0);
  return Buffer.concat([head, body, tail]);
}

/* Decode as many complete, CRC-valid frames as possible; stop at the first
 * incomplete/corrupt frame (crash tail). */
function decodeFrames(buf) {
  const frames = [];
  let pos = 0;
  while (pos < buf.length) {
    if (buf.length - pos < 8) break;
    if (buf.toString('ascii', pos, pos + 4) !== MAGIC) break;
    const len = buf.readUInt32LE(pos + 4);
    const end = pos + 8 + len + 4;
    if (end > buf.length) break;
    if (crc32(buf.subarray(pos, pos + 8 + len)) !== buf.readUInt32LE(pos + 8 + len)) break;
    let obj;
    try {
      obj = JSON.parse(buf.toString('utf8', pos + 8, pos + 8 + len));
    } catch {
      break;
    }
    frames.push({ offset: pos, end, obj });
    pos = end;
  }
  return frames;
}

function readFileOrEmpty(p) {
  try {
    return fs.readFileSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return Buffer.alloc(0);
    throw e;
  }
}

/* Lenient scan used by recover/commit/open: walks the longest valid chain.
 * Data blocks must chain (seq = head+1, prevHash = head hash); a commit block
 * seals the pending data blocks when everything after the last valid commit is
 * considered droppable. */
function scanLog(filePath) {
  const frames = decodeFrames(readFileOrEmpty(filePath));
  const committed = [];
  let pending = [];
  let head = { seq: 0, hash: GENESIS };
  let commitEnd = 0;
  let chainEnd = 0;
  for (const f of frames) {
    const o = f.obj;
    if (o && o.t === 'd' && typeof o.seq === 'number' && typeof o.prevHash === 'string') {
      if (o.seq !== head.seq + 1 || o.prevHash !== head.hash) break;
      const entry = { seq: o.seq, prevHash: o.prevHash, payload: o.payload, hash: dataHash(o) };
      pending.push(entry);
      head = { seq: o.seq, hash: entry.hash };
      chainEnd = f.end;
    } else if (o && o.t === 'c') {
      if (pending.length === 0 || o.seq !== head.seq || o.root !== head.hash) break;
      committed.push(...pending);
      pending = [];
      commitEnd = f.end;
      chainEnd = f.end;
    } else {
      break;
    }
  }
  const last = committed.length ? committed[committed.length - 1] : null;
  return {
    committed,
    pending,
    lastSeq: last ? last.seq : 0,
    root: last ? last.hash : GENESIS,
    commitEnd,
    chainEnd,
  };
}

/* ---------- checkpoint ---------- */
function checkpointPath(p) {
  return p + '.ckpt';
}

function writeCheckpoint(filePath, lastSeq, root) {
  const tmp = checkpointPath(filePath) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ lastSeq, root }) + '\n');
  fs.renameSync(tmp, checkpointPath(filePath));
}

function readCheckpoint(filePath) {
  try {
    const c = JSON.parse(fs.readFileSync(checkpointPath(filePath), 'utf8'));
    if (typeof c.lastSeq === 'number' && typeof c.root === 'string') return c;
    return null;
  } catch {
    return null;
  }
}

function fsyncFile(p) {
  const fd = fs.openSync(p, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------- public API ---------- */
function open(filePath) {
  const st = scanLog(filePath);
  const tail = st.pending.length ? st.pending[st.pending.length - 1] : null;
  return {
    path: filePath,
    baseSeq: st.lastSeq, // last committed (stale-root reference)
    baseRoot: st.root,
    headSeq: tail ? tail.seq : st.lastSeq, // chain head incl. valid pending
    headHash: tail ? tail.hash : st.root,
    pending: [],
  };
}

function append(h, payload) {
  const seq = h.headSeq + 1;
  const prevHash = h.headHash;
  const blk = { t: 'd', seq, prevHash, payload: String(payload) };
  fs.appendFileSync(h.path, encodeBlock(blk));
  const hash = dataHash(blk);
  h.headSeq = seq;
  h.headHash = hash;
  h.pending.push({ seq, prevHash, payload: blk.payload, hash });
  return seq;
}

function commit(h) {
  const st = scanLog(h.path);
  if (st.lastSeq !== h.baseSeq || st.root !== h.baseRoot) {
    throw new EvlogError(
      'ERR_STALE_ROOT',
      `handle based on seq ${h.baseSeq} root ${h.baseRoot.slice(0, 16)}…, but log is at seq ${st.lastSeq} root ${st.root.slice(0, 16)}…`
    );
  }
  // Drop any foreign garbage beyond the valid chain before sealing.
  if (fs.existsSync(h.path)) fs.truncateSync(h.path, st.chainEnd);
  if (st.pending.length === 0) {
    writeCheckpoint(h.path, st.lastSeq, st.root);
    return { lastSeq: st.lastSeq, root: st.root, committed: 0 };
  }
  const lastPending = st.pending[st.pending.length - 1];
  fs.appendFileSync(h.path, encodeBlock({ t: 'c', seq: lastPending.seq, root: lastPending.hash }));
  fsyncFile(h.path);
  writeCheckpoint(h.path, lastPending.seq, lastPending.hash);
  h.baseSeq = lastPending.seq;
  h.baseRoot = lastPending.hash;
  h.headSeq = lastPending.seq;
  h.headHash = lastPending.hash;
  h.pending = [];
  return { lastSeq: lastPending.seq, root: lastPending.hash, committed: st.pending.length };
}

function recover(filePath) {
  const st = scanLog(filePath);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '');
  const size = fs.statSync(filePath).size;
  let truncatedBytes = 0;
  if (size > st.commitEnd) {
    fs.truncateSync(filePath, st.commitEnd);
    truncatedBytes = size - st.commitEnd;
  }
  fsyncFile(filePath);
  writeCheckpoint(filePath, st.lastSeq, st.root);
  return {
    lastSeq: st.lastSeq,
    root: st.root,
    committed: st.committed.length,
    dropped: st.pending.length,
    truncatedBytes,
  };
}

/* Strict verification of the committed chain. Tolerates a truncated final
 * frame (crash tail) and well-formed uncommitted data blocks; everything else
 * is a hard error. */
function verify(filePath) {
  const buf = readFileOrEmpty(filePath);
  const frames = [];
  let pos = 0;
  while (pos < buf.length) {
    if (buf.length - pos < 8) break; // truncated header: crash tail
    if (buf.toString('ascii', pos, pos + 4) !== MAGIC) {
      throw new EvlogError('ERR_CRC', `bad magic at offset ${pos}`);
    }
    const len = buf.readUInt32LE(pos + 4);
    const end = pos + 8 + len + 4;
    if (end > buf.length) break; // truncated body: crash tail
    if (crc32(buf.subarray(pos, pos + 8 + len)) !== buf.readUInt32LE(pos + 8 + len)) {
      throw new EvlogError('ERR_CRC', `crc mismatch at offset ${pos}`);
    }
    let o;
    try {
      o = JSON.parse(buf.toString('utf8', pos + 8, pos + 8 + len));
    } catch {
      throw new EvlogError('ERR_CRC', `unparseable body at offset ${pos}`);
    }
    frames.push(o);
    pos = end;
  }
  let head = { seq: 0, hash: GENESIS };
  let committedCount = 0;
  let lastCommitted = { seq: 0, hash: GENESIS };
  let pending = [];
  for (const o of frames) {
    if (o && o.t === 'd') {
      if (typeof o.seq !== 'number' || o.seq < head.seq + 1) {
        throw new EvlogError('ERR_FORK', `sequence regression at seq ${o.seq}, expected ${head.seq + 1}`);
      }
      if (o.seq > head.seq + 1) {
        throw new EvlogError('ERR_SEQ', `sequence gap: got seq ${o.seq}, expected ${head.seq + 1}`);
      }
      if (o.prevHash !== head.hash) {
        throw new EvlogError('ERR_FORK', `prevHash mismatch at seq ${o.seq}`);
      }
      const entry = { seq: o.seq, hash: dataHash(o) };
      pending.push(entry);
      head = entry;
    } else if (o && o.t === 'c') {
      if (pending.length === 0 || o.seq !== head.seq || o.root !== head.hash) {
        throw new EvlogError('ERR_FORK', `commit block does not match pending chain at seq ${o && o.seq}`);
      }
      committedCount += pending.length;
      lastCommitted = { seq: head.seq, hash: head.hash };
      pending = [];
    } else {
      throw new EvlogError('ERR_FORK', 'unknown block type');
    }
  }
  return { ok: true, lastSeq: lastCommitted.seq, root: lastCommitted.hash, committed: committedCount, pending: pending.length };
}

function tail(filePath, n = 10) {
  const st = scanLog(filePath);
  const items = n >= st.committed.length ? st.committed : st.committed.slice(st.committed.length - n);
  return items.map((e) => ({ seq: e.seq, payload: e.payload, hash: e.hash, prevHash: e.prevHash }));
}

module.exports = {
  GENESIS,
  EvlogError,
  open,
  append,
  commit,
  recover,
  verify,
  tail,
  readCheckpoint,
  _internals: { crc32, sha256hex, dataHash, encodeBlock, decodeFrames, scanLog, checkpointPath },
};
