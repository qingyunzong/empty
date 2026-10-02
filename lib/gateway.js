'use strict';
const crypto = require('node:crypto');

// ---- crc32 (IEEE 802.3, poly 0xEDB88320) ----
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- protocol constants ----
const MAGIC = 0xaa55;          // on wire big-endian: 0xAA 0x55
const TYPE = { DATA: 0x01, END: 0x02, ABORT: 0x03 };
const HEADER_LEN = 7;          // magic(2) len(2) type(1) board(2)
const CRC_LEN = 4;
const MERKLE_BLOCK = 1024;     // fixed-size leaves over assembled data

class StructureError extends Error {
  constructor(msg) { super(msg); this.code = 'STRUCTURE'; }
}
class ConflictError extends Error {
  constructor(msg) { super(msg); this.code = 'CONFLICT'; }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

// Merkle root over fixed-size blocks of the assembled payload, so the root
// is independent of how the stream was chunked.
function merkleRoot(data) {
  const leaves = [];
  for (let i = 0; i < data.length; i += MERKLE_BLOCK) {
    leaves.push(sha256(data.subarray(i, Math.min(i + MERKLE_BLOCK, data.length))));
  }
  if (leaves.length === 0) leaves.push(sha256(Buffer.alloc(0)));
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256(Buffer.concat([level[i], right])));
    }
    level = next;
  }
  return level[0].toString('hex');
}

// ---- frame encoding (used by producers and tests) ----
function encodeFrame(type, board, payload) {
  const head = Buffer.alloc(HEADER_LEN);
  head.writeUInt16BE(MAGIC, 0);
  head.writeUInt16LE(payload.length, 2);
  head.writeUInt8(type, 4);
  head.writeUInt16LE(board, 5);
  const crc = Buffer.alloc(CRC_LEN);
  crc.writeUInt32LE(crc32(Buffer.concat([head.subarray(2), payload])), 0);
  return Buffer.concat([head, payload, crc]);
}
function encodeData(board, session, offset, data) {
  const p = Buffer.alloc(6);
  p.writeUInt16LE(session, 0);
  p.writeUInt32LE(offset, 2);
  return encodeFrame(TYPE.DATA, board, Buffer.concat([p, data]));
}
function encodeEnd(board, session) {
  const p = Buffer.alloc(2);
  p.writeUInt16LE(session, 0);
  return encodeFrame(TYPE.END, board, p);
}
function encodeAbort(board, session, reason = '') {
  const p = Buffer.alloc(2);
  p.writeUInt16LE(session, 0);
  return encodeFrame(TYPE.ABORT, board, Buffer.concat([p, Buffer.from(reason, 'utf8')]));
}

// ---- clock ----
class ManualClock {
  constructor(t = 0) { this.t = t; this.paused = false; }
  now() { return this.t; }
  advance(ms) { if (!this.paused) this.t += ms; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
}
const systemClock = { now: () => Date.now() };

// ---- helpers ----
function assemble(frags) {
  const parts = [...frags.entries()].sort((a, b) => a[0] - b[0]);
  return Buffer.concat(parts.map(([, d]) => d));
}
function gapOffsets(frags) {
  const parts = [...frags.entries()].sort((a, b) => a[0] - b[0]);
  const missing = [];
  let expect = 0;
  for (const [off, data] of parts) {
    if (off > expect) missing.push(expect);
    expect = Math.max(expect, off + data.length);
  }
  return missing;
}

// ---- gateway ----
class Gateway {
  constructor({ clock = systemClock, timeoutMs = 1000, certs = [] } = {}) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.buf = Buffer.alloc(0);
    this.boards = new Map(); // board -> { active, lastFinal }
    this.certs = certs;
    this.events = [];
    for (const c of certs) {
      const st = this._state(c.board);
      st.lastFinal = Math.max(st.lastFinal, c.session);
    }
  }

  _state(board) {
    let st = this.boards.get(board);
    if (!st) {
      st = { active: null, lastFinal: 0 };
      this.boards.set(board, st);
    }
    return st;
  }

  log(msg) {
    this.events.push(`t=${this.clock.now()} ${msg}`);
  }

  feed(chunk) {
    this.checkTimeouts();
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      if (this.buf.readUInt16BE(0) !== MAGIC) {
        throw new StructureError(`bad magic 0x${this.buf.subarray(0, 2).toString('hex')}`);
      }
      if (this.buf.length < HEADER_LEN) return;
      const len = this.buf.readUInt16LE(2);
      const type = this.buf.readUInt8(4);
      const board = this.buf.readUInt16LE(5);
      if (type !== TYPE.DATA && type !== TYPE.END && type !== TYPE.ABORT) {
        throw new StructureError(`unknown frame type ${type}`);
      }
      const minPayload = type === TYPE.DATA ? 6 : 2;
      if (len < minPayload) {
        throw new StructureError(`len ${len} too small for type ${type}`);
      }
      const total = HEADER_LEN + len + CRC_LEN;
      if (this.buf.length < total) return; // half frame: wait for more bytes
      const frame = this.buf.subarray(0, total);
      this.buf = this.buf.subarray(total);
      const expected = frame.readUInt32LE(HEADER_LEN + len);
      const actual = crc32(frame.subarray(2, HEADER_LEN + len));
      if (actual !== expected) {
        this.log(`bad_crc board=${board} type=${type} len=${len} frame_dropped`);
        continue; // crc error never terminates processing
      }
      this._dispatch(type, board, frame.subarray(HEADER_LEN, HEADER_LEN + len));
    }
  }

  _dispatch(type, board, payload) {
    const session = payload.readUInt16LE(0);
    const st = this._state(board);

    if (type === TYPE.ABORT && !st.active) {
      // Already ENDed or already ABORTed (or never started): ignore.
      this.log(`abort_ignored board=${board} session=${session}`);
      return;
    }
    if (st.active && session !== st.active.session) {
      throw new ConflictError(
        `board=${board} active session=${st.active.session} got session=${session}`);
    }
    if (!st.active && type === TYPE.DATA) {
      if (session <= st.lastFinal) {
        throw new ConflictError(
          `board=${board} session=${session} not greater than finalized session=${st.lastFinal}`);
      }
      st.active = { session, frags: new Map(), bytes: 0, lastActivity: this.clock.now(), lastNack: -Infinity };
    }

    if (type === TYPE.DATA) {
      const offset = payload.readUInt32LE(2);
      const data = payload.subarray(6);
      const a = st.active;
      a.lastActivity = this.clock.now();
      if (a.frags.has(offset)) {
        this.log(`dup board=${board} session=${session} offset=${offset} dropped`);
      } else {
        a.frags.set(offset, Buffer.from(data));
        a.bytes += data.length;
        this.log(`data board=${board} session=${session} offset=${offset} bytes=${data.length}`);
      }
    } else if (type === TYPE.END) {
      const a = st.active || { session, frags: new Map(), bytes: 0 };
      const assembled = assemble(a.frags);
      const cert = {
        board, session, status: 'committed',
        merkleRoot: merkleRoot(assembled),
        bytesReceived: assembled.length,
        discardReason: null,
      };
      this.certs.push(cert);
      st.lastFinal = Math.max(st.lastFinal, session);
      st.active = null;
      this.log(`commit board=${board} session=${session} root=${cert.merkleRoot} bytes=${cert.bytesReceived}`);
    } else { // ABORT with active session
      const a = st.active;
      const reason = payload.length > 2
        ? payload.subarray(2).toString('utf8')
        : 'aborted by producer';
      const cert = {
        board, session: a.session, status: 'aborted',
        merkleRoot: null,
        bytesReceived: a.bytes,
        discardReason: reason,
      };
      this.certs.push(cert);
      st.lastFinal = Math.max(st.lastFinal, a.session);
      st.active = null;
      this.log(`abort board=${board} session=${a.session} reason=${JSON.stringify(reason)}`);
    }
  }

  // Ask the producer to resend missing fragments when a board stalls.
  checkTimeouts() {
    const now = this.clock.now();
    for (const [board, st] of this.boards) {
      const a = st.active;
      if (!a) continue;
      if (now - a.lastActivity < this.timeoutMs) continue;
      if (now - a.lastNack < this.timeoutMs) continue;
      const missing = gapOffsets(a.frags);
      if (missing.length === 0) continue;
      a.lastNack = now;
      this.log(`retransmit_request board=${board} session=${a.session} missing_offsets=${missing.join(',')}`);
    }
  }
}

module.exports = {
  crc32, merkleRoot, sha256,
  MAGIC, TYPE, HEADER_LEN, MERKLE_BLOCK,
  StructureError, ConflictError,
  encodeFrame, encodeData, encodeEnd, encodeAbort,
  ManualClock, Gateway, assemble,
};
