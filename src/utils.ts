import type {
  ChangeStreamEvent,
  Document,
  Namespace,
  ResumeToken,
} from "./types.ts";

export const HISTORY_LOST_ERROR_CODE = 286;
export const HISTORY_LOST_ERROR_CODES: readonly number[] = Object.freeze([286]);

export const DEFAULT_VERSION_FIELDS: readonly string[] = Object.freeze([
  "_version",
  "version",
  "rev",
  "revision",
  "updatedAt",
  "updated_at",
  "modifiedAt",
  "lastModified",
  "last_modified",
  "clusterTime",
  "ts",
]);

export function normalizeNamespace(value: unknown): Namespace | null {
  if (value == null) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const dot = trimmed.indexOf(".");
    if (dot < 0) return { db: trimmed, coll: "" };
    return { db: trimmed.slice(0, dot), coll: trimmed.slice(dot + 1) };
  }

  if (typeof value !== "object") return null;
  const candidate = value as { db?: unknown; coll?: unknown; collection?: unknown };
  if (typeof candidate.db !== "string") return null;
  const coll =
    typeof candidate.coll === "string"
      ? candidate.coll
      : typeof candidate.collection === "string"
        ? candidate.collection
        : "";
  return { db: candidate.db, coll };
}

export function namespaceKey(namespace: Namespace | null): string | null {
  return namespace ? `${namespace.db}.${namespace.coll}` : null;
}

export function sameNamespace(
  left: Namespace | null,
  right: Namespace | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.db === right.db &&
    left.coll === right.coll
  );
}

export function cloneNamespace(namespace: Namespace | null): Namespace | null {
  return namespace ? { db: namespace.db, coll: namespace.coll } : null;
}

export function resumeTokenOf(event: ChangeStreamEvent): ResumeToken | null {
  if (event._id !== undefined) return event._id;
  if (event.resumeToken !== undefined) return event.resumeToken;
  return null;
}

export function isInvalidateEvent(event: ChangeStreamEvent): boolean {
  return event.operationType === "invalidate";
}

export function isRenameEvent(event: ChangeStreamEvent): boolean {
  return event.operationType === "rename";
}

export function isTransactionEvent(event: ChangeStreamEvent): boolean {
  return event.txnNumber !== undefined && event.txnNumber !== null;
}

function bytesToHex(value: ArrayBufferView): string {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

/**
 * Deterministic serialization used only to derive transaction keys. It does
 * not need to be a general BSON codec, but it must not depend on object key
 * insertion order.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const encode = (input: unknown): string => {
    if (input === null) return "null";

    switch (typeof input) {
      case "undefined":
        return "undefined";
      case "string":
        return JSON.stringify(input);
      case "boolean":
        return input ? "true" : "false";
      case "number":
        return Number.isFinite(input) ? String(input) : `number:${String(input)}`;
      case "bigint":
        return `bigint:${input.toString()}`;
      case "symbol":
        return `symbol:${String(input)}`;
      case "function":
        return `function:${input.name || "anonymous"}`;
    }

    if (input instanceof Date) return `date:${input.toISOString()}`;
    if (ArrayBuffer.isView(input)) return `bytes:${bytesToHex(input)}`;
    if (input instanceof ArrayBuffer) {
      return `bytes:${bytesToHex(new Uint8Array(input))}`;
    }
    if (Array.isArray(input)) {
      return `[${input.map((item) => encode(item)).join(",")}]`;
    }

    const object = input as Record<string, unknown>;
    const timestampSeconds = object.t;
    const timestampIncrement = object.i;
    if (
      typeof timestampSeconds === "number" &&
      typeof timestampIncrement === "number"
    ) {
      return `timestamp:${timestampSeconds}:${timestampIncrement}`;
    }
    if (typeof object.low === "number" && typeof object.high === "number") {
      return `long:${object.high}:${object.low}`;
    }
    if (ArrayBuffer.isView(object.buffer)) {
      return `bytes:${bytesToHex(object.buffer)}`;
    }
    if (
      typeof object.$timestamp === "string" ||
      typeof object.$timestamp === "number"
    ) {
      return `timestamp:${String(object.$timestamp)}`;
    }
    const toHexString = object.toHexString;
    if (typeof toHexString === "function") {
      try {
        return `hex:${String(toHexString.call(input))}`;
      } catch {
        // Fall through to generic object handling.
      }
    }

    if (seen.has(object)) return "[circular]";
    seen.add(object);
    const keys = Object.keys(object).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${encode(object[key])}`)
      .join(",")}}`;
  };

  return encode(value);
}

export function transactionKeyOf(event: ChangeStreamEvent): string | null {
  if (!isTransactionEvent(event)) return null;
  return `${stableStringify(event.lsid)}:${stableStringify(event.txnNumber)}`;
}

/**
 * Normalize a change event timestamp. MongoDB timestamps are typically
 * `{ t: seconds, i: increment }`; Date, ISO strings and epoch values are
 * accepted for testability and for other drivers.
 */
export function normalizeTimestampMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.abs(value) < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && /^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value !== "object") return null;

  const object = value as Record<string, unknown>;
  if (
    typeof object.t === "number" &&
    typeof object.i === "number" &&
    Number.isFinite(object.t)
  ) {
    return object.t * 1000 + object.i / 1000;
  }
  if (object.$timestamp !== undefined) {
    return normalizeTimestampMs(object.$timestamp);
  }
  if (typeof object.getHighBits === "function") {
    const high = Number(
      (object.getHighBits as () => unknown).call(value),
    );
    const low = Number(
      (object.getLowBits as () => unknown).call(value),
    );
    if (Number.isFinite(high) && Number.isFinite(low)) {
      return high * 4294967296 + (low >>> 0);
    }
  }
  if (object.$date !== undefined) {
    return normalizeTimestampMs(object.$date);
  }
  return null;
}

/**
 * Version values are deliberately not interpreted as seconds. A document
 * version of `2` must compare higher than `1`, not become a 1970 timestamp.
 */
export function normalizeVersionNumber(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    if (value < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
    return Number(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return Number.isFinite(numeric) ? numeric : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value !== "object") return null;

  const object = value as Record<string, unknown>;
  if (
    typeof object.t === "number" &&
    typeof object.i === "number" &&
    Number.isFinite(object.t)
  ) {
    return object.t * 1000 + object.i / 1000;
  }
  if (object.$timestamp !== undefined) {
    return normalizeVersionNumber(object.$timestamp);
  }
  if (object.$numberLong !== undefined) {
    return normalizeVersionNumber(object.$numberLong);
  }
  if (object.$date !== undefined) {
    return normalizeVersionNumber(object.$date);
  }
  if (
    typeof object.high === "number" &&
    typeof object.low === "number"
  ) {
    return object.high * 4294967296 + (object.low >>> 0);
  }
  if (typeof object.getHighBits === "function") {
    const high = Number(
      (object.getHighBits as () => unknown).call(value),
    );
    const low = Number(
      (object.getLowBits as () => unknown).call(value),
    );
    if (Number.isFinite(high) && Number.isFinite(low)) {
      return high * 4294967296 + (low >>> 0);
    }
  }

  const asString = String(value);
  if (asString !== "[object Object]") {
    return normalizeVersionNumber(asString);
  }
  return null;
}

export function extractDocumentVersion(
  document: Document | null | undefined,
  versionOf?: (document: Document) => unknown,
): unknown {
  if (!document) return null;
  if (versionOf) return versionOf(document);
  for (const field of DEFAULT_VERSION_FIELDS) {
    if (document[field] !== undefined && document[field] !== null) {
      return document[field];
    }
  }
  return null;
}

export interface VersionComparison {
  comparison: "newer" | "same" | "older" | "unknown";
  left: number | null;
  right: number | null;
}

export function compareVersionValues(
  candidate: unknown,
  baseline: unknown,
): VersionComparison {
  const left = normalizeVersionNumber(candidate);
  const right = normalizeVersionNumber(baseline);
  if (left === null || right === null) {
    return { comparison: "unknown", left, right };
  }
  if (left > right) return { comparison: "newer", left, right };
  if (left < right) return { comparison: "older", left, right };
  return { comparison: "same", left, right };
}

export function isHistoryLostError(error: unknown, depth = 0): boolean {
  if (error == null || depth > 3) return false;
  if (typeof error === "string") {
    return /change ?stream history lost/i.test(error);
  }
  if (typeof error !== "object") return false;

  const candidate = error as Record<string, unknown>;
  const code = candidate.code ?? candidate.errorCode;
  if (
    typeof code === "number" &&
    HISTORY_LOST_ERROR_CODES.includes(code)
  ) {
    return true;
  }
  if (typeof code === "string" && /^286$/.test(code.trim())) return true;

  const names = [
    candidate.name,
    candidate.codeName,
    candidate.errorLabel,
    candidate.constructor &&
      (candidate.constructor as { name?: unknown }).name,
  ];
  for (const name of names) {
    if (
      typeof name === "string" &&
      /ChangeStreamHistoryLost/i.test(name)
    ) {
      return true;
    }
  }

  if (typeof candidate.message === "string") {
    if (/change ?stream history lost/i.test(candidate.message)) return true;
    if (/resume token.*(?:no longer|not).*(?:available|found)/i.test(candidate.message)) {
      return true;
    }
  }

  return (
    isHistoryLostError(candidate.cause, depth + 1) ||
    isHistoryLostError(candidate.error, depth + 1) ||
    isHistoryLostError(candidate.originalError, depth + 1)
  );
}

export const isHistoryLost = isHistoryLostError;

export function isResumeTokenError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  const code = candidate.code ?? candidate.errorCode;
  return (
    code === 260 ||
    code === 286 ||
    (typeof candidate.message === "string" &&
      /resume token/i.test(candidate.message))
  );
}

export function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}
