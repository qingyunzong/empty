// Segment file format:
//   header:  "PLCS" (4B) | version (1B) | flags (1B) | baseTs (zigzag varint)
//   record:  frameLen (varint, covers crc+payload) | crc32 (4B LE) | payload
//   payload: seq (varint) | tsDelta (zigzag varint, vs previous event ts) | codeId (varint)
//
// Decoding stops at the first damaged frame and reports validBytes so the
// store can truncate a half-written tail deterministically.

import { uvarintEncode, uvarintDecode, zigzagEncode, zigzagDecode } from "./varint.js";
import { crc32 } from "./crc32.js";

export const MAGIC = Buffer.from([0x50, 0x4c, 0x43, 0x53]); // "PLCS"
export const VERSION = 1;

export function encodeHeader(baseTs) {
  return Buffer.concat([MAGIC, Buffer.from([VERSION, 0]), uvarintEncode(zigzagEncode(baseTs))]);
}

export function encodeRecord({ seq, tsDelta, codeId }) {
  const payload = Buffer.concat([
    uvarintEncode(seq),
    uvarintEncode(zigzagEncode(tsDelta)),
    uvarintEncode(codeId),
  ]);
  const len = uvarintEncode(payload.length + 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(payload), 0);
  return Buffer.concat([len, crc, payload]);
}

export function decodeSegment(buf) {
  const records = [];
  const fail = (validBytes, error) => ({ baseTs: 0, records, validBytes, error });
  if (buf.length < 7 || !buf.subarray(0, 4).equals(MAGIC)) return fail(0, "bad-header");
  if (buf[4] !== VERSION) return fail(0, "bad-version");
  const base = uvarintDecode(buf, 6);
  if (!base) return fail(0, "bad-header");
  const baseTs = zigzagDecode(base.value);
  let off = base.offset;
  let prevTs = baseTs;
  while (off < buf.length) {
    const frameStart = off;
    const lenRes = uvarintDecode(buf, off);
    if (!lenRes) return { baseTs, records, validBytes: frameStart, error: "truncated-length" };
    off = lenRes.offset;
    const frameLen = lenRes.value;
    if (frameLen < 5 || off + frameLen > buf.length) {
      return { baseTs, records, validBytes: frameStart, error: "truncated-payload" };
    }
    const crc = buf.readUInt32LE(off);
    const payload = buf.subarray(off + 4, off + frameLen);
    if (crc32(payload) !== crc) {
      return { baseTs, records, validBytes: frameStart, error: "crc-mismatch" };
    }
    const r1 = uvarintDecode(payload, 0);
    const r2 = r1 && uvarintDecode(payload, r1.offset);
    const r3 = r2 && uvarintDecode(payload, r2.offset);
    if (!r3 || r3.offset !== payload.length) {
      return { baseTs, records, validBytes: frameStart, error: "bad-payload" };
    }
    prevTs += zigzagDecode(r2.value);
    records.push({ seq: r1.value, ts: prevTs, codeId: r3.value });
    off += frameLen;
  }
  return { baseTs, records, validBytes: off, error: null };
}
