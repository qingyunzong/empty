// WAL frame layout (little-endian):
//   [0..3]  u32 payload length
//   [4..7]  u32 wal sequence number
//   [8]     u8  frame type (0x01 = data, 0x02 = commit marker)
//   [9..]   payload bytes (length bytes; commit frames have length 0)
//   [..+4]  u32 CRC32 over header + payload
import { crc32 } from './crc32.js';

export const TYPE_DATA = 0x01;
export const TYPE_COMMIT = 0x02;
export const HEADER_SIZE = 9;
export const CRC_SIZE = 4;
export const MIN_FRAME_SIZE = HEADER_SIZE + CRC_SIZE;
export const MAX_PAYLOAD = 8 * 1024 * 1024;

export function encodeFrame(type, seq, payload = Buffer.alloc(0)) {
  const frame = Buffer.alloc(HEADER_SIZE + payload.length + CRC_SIZE);
  frame.writeUInt32LE(payload.length, 0);
  frame.writeUInt32LE(seq, 4);
  frame.writeUInt8(type, 8);
  payload.copy(frame, HEADER_SIZE);
  const crc = crc32(frame.subarray(0, HEADER_SIZE + payload.length));
  frame.writeUInt32LE(crc, HEADER_SIZE + payload.length);
  return frame;
}

// Scans a buffer as a sequence of frames. Stops at the first incomplete or
// corrupt frame; returns the valid frames and the length of the valid prefix.
export function scanBuffer(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < MIN_FRAME_SIZE) break;
    const len = buf.readUInt32LE(offset);
    const seq = buf.readUInt32LE(offset + 4);
    const type = buf.readUInt8(offset + 8);
    if (len > MAX_PAYLOAD) break;
    if (type !== TYPE_DATA && type !== TYPE_COMMIT) break;
    if (type === TYPE_COMMIT && len !== 0) break;
    const end = offset + HEADER_SIZE + len + CRC_SIZE;
    if (end > buf.length) break;
    const stored = buf.readUInt32LE(offset + HEADER_SIZE + len);
    const actual = crc32(buf.subarray(offset, offset + HEADER_SIZE + len));
    if (stored !== actual) break;
    frames.push({
      offset,
      seq,
      type,
      payload: Buffer.from(buf.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + len)),
    });
    offset = end;
  }
  return { frames, validBytes: offset };
}
