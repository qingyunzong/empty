import { createHash } from "node:crypto";

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object") {
    const aObj = a as JsonObject;
    const bObj = b as JsonObject;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => k in bObj && deepEqual(aObj[k], bObj[k]));
  }
  return false;
}

export function clone<T extends JsonValue>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Canonical JSON: object keys sorted recursively, so digest is structure-stable. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as JsonObject;
  const body = Object.keys(obj)
    .sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
    .join(",");
  return "{" + body + "}";
}

/** sha256 hex digest of the canonical form of a JSON value. */
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function getAtPath(doc: JsonValue, path: string[]): JsonValue | undefined {
  let cur: JsonValue | undefined = doc;
  for (const key of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function pathKey(path: string[]): string {
  return JSON.stringify(path);
}

export function formatPath(path: string[]): string {
  return path.length === 0 ? "<root>" : path.map((p) => JSON.stringify(p)).join(".");
}
