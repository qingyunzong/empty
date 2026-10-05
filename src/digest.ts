import { createHash, timingSafeEqual } from "node:crypto";

const HEX_SHA256 = /^[0-9a-f]{64}$/;

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export function isSha256Hex(value: string): boolean {
  return HEX_SHA256.test(value);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Constant-time comparison of two sha256 hex digests (case-insensitive). */
export function digestEquals(declared: string, computed: string): boolean {
  const a = declared.toLowerCase();
  const b = computed.toLowerCase();
  if (!isSha256Hex(a) || !isSha256Hex(b)) {
    return false;
  }
  return timingSafeEqual(hexToBytes(a), hexToBytes(b));
}

/** Stable JSON serialization: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + stableStringify(record[k]));
  return "{" + parts.join(",") + "}";
}
