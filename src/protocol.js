'use strict';

const { FrameError } = require('./errors');

// Binary frame layout (big-endian):
//   0..1   magic 'VF'
//   2      version (1)
//   3..6   msgId     uint32  (identifies the logical message)
//   7..8   fragIndex uint16  (0-based)
//   9..10  fragCount uint16  (>=1)
//   11..12 payloadLen uint16
//   13..   payload bytes (chunk of the UTF-8 JSON message)
const MAGIC = Buffer.from([0x56, 0x46]); // 'VF'
const VERSION = 1;
const HEADER_LEN = 13;
const MAX_PAYLOAD = 0xffff;

function encodeFrame({ msgId, fragIndex = 0, fragCount = 1, payload }) {
  if (!Number.isInteger(msgId) || msgId < 0 || msgId > 0xffffffff) {
    throw new FrameError('msgId must be a uint32');
  }
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(String(payload), 'utf8');
  if (payload.length > MAX_PAYLOAD) throw new FrameError('payload too large for one frame');
  if (!Number.isInteger(fragCount) || fragCount < 1 || fragCount > 0xffff) throw new FrameError('bad fragCount');
  if (!Number.isInteger(fragIndex) || fragIndex < 0 || fragIndex >= fragCount) throw new FrameError('bad fragIndex');
  const buf = Buffer.alloc(HEADER_LEN + payload.length);
  MAGIC.copy(buf, 0);
  buf.writeUInt8(VERSION, 2);
  buf.writeUInt32BE(msgId, 3);
  buf.writeUInt16BE(fragIndex, 7);
  buf.writeUInt16BE(fragCount, 9);
  buf.writeUInt16BE(payload.length, 11);
  payload.copy(buf, HEADER_LEN);
  return buf;
}

function decodeFrame(buf) {
  if (!Buffer.isBuffer(buf)) throw new FrameError('frame must be a Buffer');
  if (buf.length < HEADER_LEN) throw new FrameError(`frame too short: ${buf.length} bytes`);
  if (buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1]) throw new FrameError('bad frame magic');
  if (buf.readUInt8(2) !== VERSION) throw new FrameError(`unsupported frame version ${buf.readUInt8(2)}`);
  const msgId = buf.readUInt32BE(3);
  const fragIndex = buf.readUInt16BE(7);
  const fragCount = buf.readUInt16BE(9);
  const payloadLen = buf.readUInt16BE(11);
  if (fragCount < 1) throw new FrameError('fragCount must be >= 1');
  if (fragIndex >= fragCount) throw new FrameError(`fragIndex ${fragIndex} out of range (fragCount ${fragCount})`);
  if (buf.length !== HEADER_LEN + payloadLen) {
    throw new FrameError(`frame length mismatch: header says ${payloadLen} payload bytes, got ${buf.length - HEADER_LEN}`);
  }
  return { msgId, fragIndex, fragCount, payload: buf.subarray(HEADER_LEN) };
}

// Splits a message into frames of at most maxPayload bytes.
function fragmentMessage(msgId, message, maxPayload = 128) {
  const data = Buffer.from(message, 'utf8');
  if (data.length === 0 || maxPayload <= 0) throw new FrameError('bad message or maxPayload');
  const fragCount = Math.ceil(data.length / maxPayload);
  const frames = [];
  for (let i = 0; i < fragCount; i++) {
    frames.push(encodeFrame({
      msgId,
      fragIndex: i,
      fragCount,
      payload: data.subarray(i * maxPayload, (i + 1) * maxPayload),
    }));
  }
  return frames;
}

// Reassembles messages from frames. Handles duplicates (idempotent),
// out-of-order fragments, fragmentation, and timeout-based retransmission
// (incomplete fragment groups expire and can be rebuilt by retransmitted frames).
class Receiver {
  constructor({ timeoutMs = 30000, maxCompleted = 1024 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxCompleted = maxCompleted;
    this.pending = new Map(); // msgId -> { fragCount, frags: Map, firstSeen }
    this.completed = new Set(); // msgIds already delivered
    this.completedOrder = [];
  }

  // Returns an array of complete messages (UTF-8 strings) finished by this frame.
  feed(frameBuf, now = Date.now()) {
    this.purgeExpired(now);
    const frame = decodeFrame(frameBuf);
    if (this.completed.has(frame.msgId)) return []; // retransmission of a done message: ignore

    if (frame.fragCount === 1) {
      this.#markCompleted(frame.msgId);
      return [frame.payload.toString('utf8')];
    }

    let group = this.pending.get(frame.msgId);
    if (!group) {
      group = { fragCount: frame.fragCount, frags: new Map(), firstSeen: now };
      this.pending.set(frame.msgId, group);
    }
    if (group.fragCount !== frame.fragCount) {
      throw new FrameError(`inconsistent fragCount for msgId ${frame.msgId}`);
    }
    if (!group.frags.has(frame.fragIndex)) {
      group.frags.set(frame.fragIndex, Buffer.from(frame.payload));
    }
    if (group.frags.size !== group.fragCount) return [];

    const parts = [];
    for (let i = 0; i < group.fragCount; i++) parts.push(group.frags.get(i));
    this.pending.delete(frame.msgId);
    this.#markCompleted(frame.msgId);
    return [Buffer.concat(parts).toString('utf8')];
  }

  purgeExpired(now = Date.now()) {
    for (const [msgId, group] of this.pending) {
      if (now - group.firstSeen > this.timeoutMs) this.pending.delete(msgId);
    }
  }

  #markCompleted(msgId) {
    this.completed.add(msgId);
    this.completedOrder.push(msgId);
    while (this.completedOrder.length > this.maxCompleted) {
      const oldest = this.completedOrder.shift();
      this.completed.delete(oldest);
    }
  }
}

module.exports = { encodeFrame, decodeFrame, fragmentMessage, Receiver, HEADER_LEN };
