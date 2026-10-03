// Write-ahead log: framed records with CRC-32.
//
// Frame layout (little-endian):
//   u32 frameLen   bytes after this field = 1 (type) + 4 (txId) + payloadLen
//   u8  type       1=BEGIN 2=PUT 3=DEL 4=COMMIT
//   u32 txId
//   u8* payload    JSON for PUT (record) / DEL ({id}); empty for BEGIN/COMMIT
//   u32 crc32      over type+txId+payload
import { crc32 } from './crc32.js';

export const REC = { BEGIN: 1, PUT: 2, DEL: 3, COMMIT: 4 };

const HEADER = 9; // u32 len + u8 type + u32 txId
const CRC_LEN = 4;

export function encodeFrame(type, txId, payload = Buffer.alloc(0)) {
  const frameLen = 1 + 4 + payload.length;
  const buf = Buffer.alloc(4 + frameLen + CRC_LEN);
  buf.writeUInt32LE(frameLen, 0);
  buf.writeUInt8(type, 4);
  buf.writeUInt32LE(txId >>> 0, 5);
  payload.copy(buf, HEADER);
  buf.writeUInt32LE(crc32(buf.subarray(4, HEADER + payload.length)), HEADER + payload.length);
  return buf;
}

export function encodeTransaction(txId, ops) {
  const parts = [encodeFrame(REC.BEGIN, txId)];
  for (const op of ops) {
    if (op.kind === 'put') {
      parts.push(encodeFrame(REC.PUT, txId, Buffer.from(JSON.stringify(op.record), 'utf8')));
    } else {
      parts.push(encodeFrame(REC.DEL, txId, Buffer.from(JSON.stringify({ id: op.id }), 'utf8')));
    }
  }
  parts.push(encodeFrame(REC.COMMIT, txId));
  return Buffer.concat(parts);
}

// Parse frames from `buf` starting at `fromOffset`. Stops at the first torn or
// corrupt frame. Returns { frames, goodEnd } where goodEnd is the offset just
// past the last valid frame (callers may truncate the file there).
export function parseFrames(buf, fromOffset = 0) {
  const frames = [];
  let pos = fromOffset;
  while (pos + HEADER + CRC_LEN <= buf.length) {
    const frameLen = buf.readUInt32LE(pos);
    const end = pos + 4 + frameLen + CRC_LEN;
    if (frameLen < 5 || end > buf.length) break; // torn tail
    const body = buf.subarray(pos + 4, pos + 4 + frameLen);
    const storedCrc = buf.readUInt32LE(pos + 4 + frameLen);
    if (crc32(body) !== storedCrc) break; // corrupt frame
    const type = body.readUInt8(0);
    const txId = body.readUInt32LE(1);
    const payload = body.subarray(5);
    frames.push({ type, txId, payload, offset: pos, end });
    pos = end;
  }
  return { frames, goodEnd: pos };
}

// Replay committed transactions from a frame list into `apply(op)`.
// Uncommitted transactions (crash mid-transaction) are discarded.
export function replayCommitted(frames, apply) {
  const pending = new Map(); // txId -> ops[]
  const order = [];
  for (const f of frames) {
    if (f.type === REC.BEGIN) {
      if (!pending.has(f.txId)) {
        pending.set(f.txId, []);
        order.push(f.txId);
      }
    } else if (f.type === REC.PUT) {
      const ops = pending.get(f.txId);
      if (ops) ops.push({ kind: 'put', record: JSON.parse(f.payload.toString('utf8')) });
    } else if (f.type === REC.DEL) {
      const ops = pending.get(f.txId);
      if (ops) ops.push({ kind: 'del', id: JSON.parse(f.payload.toString('utf8')).id });
    } else if (f.type === REC.COMMIT) {
      const ops = pending.get(f.txId);
      if (ops) {
        for (const op of ops) apply(op);
        pending.delete(f.txId);
      }
    }
  }
}
