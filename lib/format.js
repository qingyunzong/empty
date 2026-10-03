import { createHash } from "node:crypto";
import { crc32 } from "./crc32.js";
import { CorruptError } from "./errors.js";

export const MAGIC = Buffer.from("TXB1", "latin1");
export const HEADER_LEN = 4 + 8 + 32 + 1 + 4 + 4; // 53
export const TRAILER_LEN = 4 + 4; // crc32 + blockLen
export const ZERO_HASH = Buffer.alloc(32);

export class IncompleteTail extends Error {
  constructor(message) {
    super(message);
    this.name = "IncompleteTail";
  }
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest();
}

export function encodeBlock({ seq, prevHash, records, snapshot = null }) {
  const payloadObj = snapshot ? { records, snapshot } : { records };
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeBigUInt64BE(BigInt(seq), 4);
  Buffer.from(prevHash).copy(header, 12);
  header.writeUInt8(snapshot ? 1 : 0, 44);
  header.writeUInt32BE(records.length, 45);
  header.writeUInt32BE(payload.length, 49);
  const body = Buffer.concat([header, payload]);
  const trailer = Buffer.alloc(TRAILER_LEN);
  trailer.writeUInt32BE(crc32(body), 0);
  trailer.writeUInt32BE(body.length + TRAILER_LEN, 4);
  return Buffer.concat([body, trailer]);
}

export function decodeBlockAt(buf, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0 || offset > buf.length) {
    throw new CorruptError("OUT_OF_BOUNDS", `越界读取: offset ${offset} 超出文件长度 ${buf.length}`);
  }
  if (offset + HEADER_LEN > buf.length) {
    throw new IncompleteTail(`块头不完整: offset ${offset}, 剩余 ${buf.length - offset} 字节`);
  }
  if (!buf.subarray(offset, offset + 4).equals(MAGIC)) {
    throw new CorruptError("BAD_MAGIC", `offset ${offset} 处魔数不匹配`);
  }
  const seq = Number(buf.readBigUInt64BE(offset + 4));
  const prevHash = Buffer.from(buf.subarray(offset + 12, offset + 44));
  const hasSnapshot = buf.readUInt8(offset + 44) === 1;
  const recordCount = buf.readUInt32BE(offset + 45);
  const payloadLen = buf.readUInt32BE(offset + 49);
  const total = HEADER_LEN + payloadLen + TRAILER_LEN;
  if (offset + total > buf.length) {
    throw new IncompleteTail(
      `块不完整: seq ${seq} 需要 ${total} 字节, 文件仅剩 ${buf.length - offset} 字节`,
    );
  }
  const body = buf.subarray(offset, offset + HEADER_LEN + payloadLen);
  const expectedCrc = buf.readUInt32BE(offset + HEADER_LEN + payloadLen);
  if (crc32(body) !== expectedCrc) {
    throw new CorruptError("CRC_MISMATCH", `seq ${seq} CRC32 校验失败`);
  }
  const blockLen = buf.readUInt32BE(offset + HEADER_LEN + payloadLen + 4);
  if (blockLen !== total) {
    throw new CorruptError(
      "INCOMPLETE_BLOCK",
      `块不完整: seq ${seq} 尾部长度字段 ${blockLen} 与实际长度 ${total} 不一致`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(body.subarray(HEADER_LEN).toString("utf8"));
  } catch {
    throw new CorruptError("BAD_PAYLOAD", `seq ${seq} 负载不是合法 JSON`);
  }
  if (!parsed || !Array.isArray(parsed.records) || parsed.records.length !== recordCount) {
    throw new CorruptError("BAD_PAYLOAD", `seq ${seq} 记录数与头部不一致`);
  }
  if (hasSnapshot && (parsed.snapshot === null || typeof parsed.snapshot !== "object")) {
    throw new CorruptError("BAD_PAYLOAD", `seq ${seq} 缺少索引快照`);
  }
  const bytes = Buffer.from(buf.subarray(offset, offset + total));
  return {
    seq,
    prevHash,
    records: parsed.records,
    snapshot: parsed.snapshot ?? null,
    length: total,
    hash: sha256(bytes),
    bytes,
  };
}
