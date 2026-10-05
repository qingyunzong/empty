/**
 * http-cache-key: canonical cache keys for HTTP requests.
 *
 * Design invariant (one-directional safety):
 *   buildCacheKey(a) === buildCacheKey(b)  ==>  a and b are semantically
 *   interchangeable for caching, modulo the configured `varyHeaders`.
 *
 * The converse is intentionally NOT guaranteed: normalization is
 * conservative and only folds differences that are semantically
 * insignificant per RFC 9110 / RFC 3986 / RFC 6265.
 */

import { createHash } from "node:crypto";

export const KEY_FORMAT_VERSION = "http-cache-key/v1";

export type HeaderLine = readonly [name: string, value: string];

export interface RawRequest {
  readonly method: string;
  /** Request target in origin-form: "/path" optionally followed by "?query". */
  readonly path: string;
  /** Ordered header lines; duplicates allowed and merged per rule. */
  readonly headers: readonly HeaderLine[];
}

export interface CacheKeyOptions {
  /** Header field names (any case) that participate in the cache key. */
  readonly varyHeaders: readonly string[];
}

export interface CacheKeyAudit {
  readonly method: string;
  readonly path: string;
  /** Normalized, merged header lines that fed into the key. */
  readonly usedHeaders: readonly HeaderLine[];
  /**
   * Header lines excluded from the key, preserved verbatim (original name
   * case, original value, original order) for audit provenance.
   */
  readonly ignoredHeaders: readonly HeaderLine[];
}

export interface CacheKeyResult {
  /** Canonical serialization; string equality is the equivalence relation. */
  readonly key: string;
  /** SHA-256 hex digest of `key`, convenient as a storage identifier. */
  readonly digest: string;
  readonly audit: CacheKeyAudit;
}

export type CacheKeyErrorCode =
  | "ERR_METHOD_TOKEN"
  | "ERR_HEADER_NAME"
  | "ERR_HEADER_NEWLINE"
  | "ERR_HEADER_CONTROL"
  | "ERR_DUPLICATE_SINGLETON";

export class CacheKeyError extends Error {
  readonly code: CacheKeyErrorCode;
  constructor(code: CacheKeyErrorCode, message: string) {
    super(message);
    this.name = "CacheKeyError";
    this.code = code;
  }
}

/** RFC 9110 section 5.1: token = 1*tchar. */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Duplicate-header merge rules (RFC 9110 section 5.3, RFC 6265 section 5.4):
 * - "comma-list": list-based fields; recipient may combine lines with ",".
 * - "cookie": Cookie lines combine with "; " (RFC 6265), never plain ",".
 * - "tuple": Set-Cookie MUST NOT be combined; kept as an ordered tuple.
 * - "singleton": duplicates are a protocol error; rejected, not merged.
 */
type MergeRule = "comma-list" | "cookie" | "tuple" | "singleton";

const COOKIE_HEADERS = new Set(["cookie"]);
const TUPLE_HEADERS = new Set(["set-cookie"]);
const SINGLETON_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "authorization",
  "user-agent",
  "referer",
  "expect",
  "max-forwards",
  "if-modified-since",
  "if-unmodified-since",
]);

function mergeRuleFor(name: string): MergeRule {
  if (COOKIE_HEADERS.has(name)) return "cookie";
  if (TUPLE_HEADERS.has(name)) return "tuple";
  if (SINGLETON_HEADERS.has(name)) return "singleton";
  return "comma-list";
}

function normalizeMethod(method: string): string {
  if (!TOKEN_RE.test(method)) {
    throw new CacheKeyError(
      "ERR_METHOD_TOKEN",
      `invalid HTTP method token: ${JSON.stringify(method)}`,
    );
  }
  // Registered methods are uppercase; origin servers match method tokens
  // case-insensitively in practice, so case-fold to upper.
  return method.toUpperCase();
}

function normalizeHeaderName(name: string): string {
  if (!TOKEN_RE.test(name)) {
    throw new CacheKeyError(
      "ERR_HEADER_NAME",
      `invalid header field name: ${JSON.stringify(name)}`,
    );
  }
  // Field names are case-insensitive (RFC 9110 section 5.1).
  return name.toLowerCase();
}

function normalizeHeaderValue(name: string, value: string): string {
  // Hard reject: a CR or LF in a field value is a request-smuggling vector.
  if (value.includes("\r") || value.includes("\n")) {
    throw new CacheKeyError(
      "ERR_HEADER_NEWLINE",
      `header "${name}" rejected: CR/LF in field value`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      throw new CacheKeyError(
        "ERR_HEADER_CONTROL",
        `header "${name}" rejected: control character 0x${code.toString(16)}`,
      );
    }
  }
  // Strip optional whitespace around the field value (RFC 9110 section 5.5);
  // interior whitespace is preserved (conservative).
  return value.replace(/^[\t ]+/, "").replace(/[\t ]+$/, "");
}

function isUnreservedByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x5f || // _
    byte === 0x7e // ~
  );
}

const HEX_DIGIT_RE = /^[0-9A-Fa-f]$/;

/**
 * RFC 3986 section 6.2.2.3: percent-encoded unreserved characters are
 * decoded; all other percent-triplets are normalized to uppercase hex.
 * Reserved characters (e.g. %2F) are never decoded. Malformed "%" sequences
 * are kept literal.
 */
export function normalizePercentEncoding(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input.charAt(i);
    if (
      ch === "%" &&
      i + 2 < input.length &&
      HEX_DIGIT_RE.test(input.charAt(i + 1)) &&
      HEX_DIGIT_RE.test(input.charAt(i + 2))
    ) {
      const byte = Number.parseInt(input.slice(i + 1, i + 3), 16);
      if (isUnreservedByte(byte)) {
        out += String.fromCharCode(byte);
      } else {
        out += "%" + input.slice(i + 1, i + 3).toUpperCase();
      }
      i += 2;
    } else {
      out += ch;
    }
  }
  return out;
}

/** RFC 3986 section 5.2.4: remove_dot_segments. */
export function removeDotSegments(path: string): string {
  let input = path;
  let output = "";
  while (input.length > 0) {
    if (input.startsWith("../")) {
      input = input.slice(3);
    } else if (input.startsWith("./")) {
      input = input.slice(2);
    } else if (input.startsWith("/./")) {
      input = "/" + input.slice(3);
    } else if (input === "/.") {
      input = "/";
    } else if (input.startsWith("/../")) {
      input = "/" + input.slice(4);
      output = output.slice(0, output.lastIndexOf("/"));
    } else if (input === "/..") {
      input = "/";
      output = output.slice(0, output.lastIndexOf("/"));
    } else if (input === "." || input === "..") {
      input = "";
    } else {
      let segment: string;
      if (input.startsWith("/")) {
        const next = input.indexOf("/", 1);
        segment = next === -1 ? input : input.slice(0, next);
      } else {
        const next = input.indexOf("/");
        segment = next === -1 ? input : input.slice(0, next);
      }
      output += segment;
      input = input.slice(segment.length);
    }
  }
  return output;
}

/**
 * Path normalization, limited to transformations RFC 3986 guarantees are
 * semantics-preserving: unreserved percent-decoding, hex case folding, and
 * dot-segment removal. The query string is kept verbatim except for the
 * same percent-encoding normalization; parameter order and duplicates are
 * significant and preserved. Trailing slashes and letter case are
 * significant and preserved.
 */
export function normalizePath(target: string): string {
  const qIndex = target.indexOf("?");
  const rawPath = qIndex === -1 ? target : target.slice(0, qIndex);
  const rawQuery = qIndex === -1 ? undefined : target.slice(qIndex + 1);
  let path = removeDotSegments(normalizePercentEncoding(rawPath));
  if (path === "") path = "/";
  if (rawQuery === undefined) return path;
  return path + "?" + normalizePercentEncoding(rawQuery);
}

export function buildCacheKey(
  request: RawRequest,
  options: CacheKeyOptions,
): CacheKeyResult {
  const method = normalizeMethod(request.method);
  const path = normalizePath(request.path);

  const varySet = new Set<string>();
  for (const raw of options.varyHeaders) {
    varySet.add(normalizeHeaderName(raw));
  }

  const grouped = new Map<string, string[]>();
  const ignored: HeaderLine[] = [];

  for (const [rawName, rawValue] of request.headers) {
    const name = normalizeHeaderName(rawName);
    const value = normalizeHeaderValue(name, rawValue);
    if (!varySet.has(name)) {
      // Excluded from the key, but retained verbatim for audit provenance.
      ignored.push([rawName, rawValue]);
      continue;
    }
    const existing = grouped.get(name);
    if (existing) {
      existing.push(value);
    } else {
      grouped.set(name, [value]);
    }
  }

  const used: HeaderLine[] = [];
  const keyHeaders: Array<readonly [string, string | readonly string[]]> = [];

  // Field-name ordering is insignificant across distinct field names
  // (RFC 9110 section 5.3), so sort for a canonical form.
  for (const name of [...grouped.keys()].sort()) {
    const values = grouped.get(name) as string[];
    const rule = mergeRuleFor(name);
    if (rule === "singleton") {
      if (values.length > 1) {
        throw new CacheKeyError(
          "ERR_DUPLICATE_SINGLETON",
          `header "${name}" is not list-based; ${values.length} lines cannot be merged`,
        );
      }
      const only = values[0] as string;
      used.push([name, only]);
      keyHeaders.push([name, only]);
    } else if (rule === "cookie") {
      const merged = values.join("; ");
      used.push([name, merged]);
      keyHeaders.push([name, merged]);
    } else if (rule === "tuple") {
      for (const v of values) used.push([name, v]);
      keyHeaders.push([name, values]);
    } else {
      const merged = values.join(",");
      used.push([name, merged]);
      keyHeaders.push([name, merged]);
    }
  }

  const key = JSON.stringify([KEY_FORMAT_VERSION, method, path, keyHeaders]);
  const digest = createHash("sha256").update(key, "utf8").digest("hex");

  return {
    key,
    digest,
    audit: { method, path, usedHeaders: used, ignoredHeaders: ignored },
  };
}
