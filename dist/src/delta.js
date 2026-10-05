import { createHash } from "node:crypto";
/** 稳定序列化：对象键排序，保证同一 payload 摘要确定。 */
export function canonicalize(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "undefined";
    }
    if (Array.isArray(value)) {
        return "[" + value.map(canonicalize).join(",") + "]";
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    return ("{" +
        keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
        "}");
}
export function computeChecksum(payload) {
    return createHash("sha256").update(canonicalize(payload)).digest("hex");
}
/** 构造一条差量并自动计算摘要。 */
export function makeDelta(id, parentId, payload) {
    return { id, parentId, payload, checksum: computeChecksum(payload) };
}
