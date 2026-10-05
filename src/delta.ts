import { createHash } from "node:crypto";

/** 版本差量：每项声明其父版本（根版本 parentId 为 null）。 */
export interface Delta {
  id: string;
  parentId: string | null;
  payload: Record<string, unknown>;
  /** 对 payload 的 sha256 摘要（十六进制），用于坏摘要检测。 */
  checksum: string;
}

/** 稳定序列化：对象键排序，保证同一 payload 摘要确定。 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}"
  );
}

export function computeChecksum(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

/** 构造一条差量并自动计算摘要。 */
export function makeDelta(
  id: string,
  parentId: string | null,
  payload: Record<string, unknown>,
): Delta {
  return { id, parentId, payload, checksum: computeChecksum(payload) };
}
