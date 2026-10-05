/**
 * Exhaustive collision audit.
 *
 * Property under test (the library's safety invariant):
 *
 *   buildCacheKey(a) === buildCacheKey(b)
 *     ==>  oracleFingerprint(a) === oracleFingerprint(b)
 *
 * where `oracleFingerprint` is an INDEPENDENT semantic canonicalization
 * written against the specs (WHATWG URL for dot-segment removal, RFC 3986
 * for percent-encoding, RFC 9110/6265 for header merging), not by calling
 * the library. The full cross-product of a small request space is
 * enumerated; every pair of requests sharing a cache key must be
 * semantically equivalent modulo the configured vary headers.
 */

import { test } from "node:test";
import {
  deepStrictEqual,
  ok,
  strictEqual,
} from "node:assert/strict";
import {
  buildCacheKey,
  type HeaderLine,
  type RawRequest,
} from "../src/cache-key.js";

const VARY = ["Accept", "X-Mode"] as const;
const VARY_LOWER = new Set(VARY.map((v) => v.toLowerCase()));

/* ---------- independent semantic oracle (does not import library logic) --- */

function oraclePercentNormalize(s: string): string {
  return s.replace(/%[0-9a-fA-F]{2}/g, (triplet) => {
    const byte = Number.parseInt(triplet.slice(1), 16);
    const ch = String.fromCharCode(byte);
    return /[A-Za-z0-9\-._~]/.test(ch)
      ? ch
      : "%" + triplet.slice(1).toUpperCase();
  });
}

function oracleFingerprint(request: RawRequest): string {
  const method = request.method.toUpperCase();
  // WHATWG URL performs dot-segment removal and empty-path normalization.
  const url = new URL(request.path, "http://oracle.invalid");
  const path = oraclePercentNormalize(url.pathname);
  const query = oraclePercentNormalize(url.search.replace(/^\?/, ""));

  const grouped = new Map<string, string[]>();
  for (const [rawName, rawValue] of request.headers) {
    const name = rawName.toLowerCase();
    if (!VARY_LOWER.has(name)) continue;
    const value = rawValue.replace(/^[\t ]+|[\t ]+$/g, "");
    const existing = grouped.get(name);
    if (existing) existing.push(value);
    else grouped.set(name, [value]);
  }
  const merged = [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, values]) =>
      name === "cookie"
        ? [name, values.join("; ")]
        : name === "set-cookie"
          ? [name, values]
          : [name, values.join(",")],
    );

  return JSON.stringify([method, path, query, merged]);
}

/* ---------- request space ------------------------------------------------ */

const METHODS = ["GET", "get", "POST", "HEAD"];

const PATHS = [
  "/",
  "/a",
  "/a/",
  "/a/b",
  "/a//b",
  "/a/./b",
  "/a/x/../b",
  "/a/%2E%2E/b",
  "/~user",
  "/%7Euser",
  "/%7euser",
  "/a%2Fb",
  "/a%2fb",
  "/?q=1",
  "/?q=%7E",
  "/?q=1&r=2",
  "/?r=2&q=1",
  "",
  "?q=1",
];

const ACCEPT_VARIANTS: readonly (readonly HeaderLine[])[] = [
  [],
  [["Accept", "text/html"]],
  [["accept", "  text/html  "]],
  [["Accept", "text/html,application/json"]],
  [["Accept", "text/html"], ["ACCEPT", "application/json"]],
];

const X_MODE_VARIANTS: readonly (readonly HeaderLine[])[] = [
  [],
  [["X-Mode", "1"]],
  [["x-mode", "2"]],
];

// X-Trace is deliberately NOT in VARY: it must be ignored for the key but
// retained in the audit trail.
const X_TRACE_VARIANTS: readonly (readonly HeaderLine[])[] = [
  [],
  [["X-Trace", "t1"]],
  [["X-Trace", "t2"]],
];

function enumerateRequests(): RawRequest[] {
  const requests: RawRequest[] = [];
  for (const method of METHODS) {
    for (const path of PATHS) {
      for (const accept of ACCEPT_VARIANTS) {
        for (const mode of X_MODE_VARIANTS) {
          for (const trace of X_TRACE_VARIANTS) {
            requests.push({
              method,
              path,
              headers: [...accept, ...mode, ...trace],
            });
          }
        }
      }
    }
  }
  return requests;
}

/* ---------- tests -------------------------------------------------------- */

test("exhaustive: equal cache keys imply semantic equivalence", (t) => {
  const requests = enumerateRequests();

  const byKey = new Map<string, RawRequest[]>();
  for (const request of requests) {
    const { key } = buildCacheKey(request, { varyHeaders: VARY });
    const bucket = byKey.get(key);
    if (bucket) bucket.push(request);
    else byKey.set(key, [request]);
  }

  let verifiedPairs = 0;
  let multiRequestKeys = 0;
  for (const group of byKey.values()) {
    const reference = oracleFingerprint(group[0] as RawRequest);
    if (group.length > 1) multiRequestKeys++;
    for (const other of group) {
      strictEqual(
        oracleFingerprint(other),
        reference,
        "cache-key collision between semantically different requests:\n" +
          `  ${JSON.stringify(group[0])}\n  ${JSON.stringify(other)}`,
      );
      verifiedPairs++;
    }
  }

  t.diagnostic(`requests enumerated: ${requests.length}`);
  t.diagnostic(`distinct cache keys: ${byKey.size}`);
  t.diagnostic(`keys shared by >1 request: ${multiRequestKeys}`);
  t.diagnostic(`same-key pairs verified equivalent: ${verifiedPairs}`);
  ok(verifiedPairs >= requests.length);
});

test("exhaustive: ignored headers keep audit provenance, never leak into key", () => {
  const requests = enumerateRequests();
  let ignoredLines = 0;

  for (const request of requests) {
    const { key, audit } = buildCacheKey(request, { varyHeaders: VARY });

    const expectedIgnored = request.headers.filter(
      ([name]) => !VARY_LOWER.has(name.toLowerCase()),
    );
    // Verbatim provenance: original name case, original value, original order.
    deepStrictEqual(audit.ignoredHeaders, expectedIgnored);
    ignoredLines += expectedIgnored.length;

    // Every header feeding the key is a vary header.
    for (const [name] of audit.usedHeaders) {
      ok(VARY_LOWER.has(name), `non-vary header in key material: ${name}`);
    }

    // Ignored values must not appear in the serialized key.
    for (const [, value] of expectedIgnored) {
      ok(
        !key.includes(value),
        `ignored header value leaked into key: ${JSON.stringify(value)}`,
      );
    }
  }

  ok(ignoredLines > 0, "enumeration should exercise ignored headers");
});

test("exhaustive: key equality is exactly the oracle equivalence on vary-only requests", () => {
  // Stronger, bidirectional check on the subspace without ignored headers
  // and without interior-whitespace list variants: here the library must
  // neither merge distinct semantics nor split equal semantics.
  const requests = enumerateRequests().filter(
    (r) => !r.headers.some(([n]) => n.toLowerCase() === "x-trace"),
  );

  const byKey = new Map<string, string>();
  const byFingerprint = new Map<string, string>();
  for (const request of requests) {
    const { key } = buildCacheKey(request, { varyHeaders: VARY });
    const fingerprint = oracleFingerprint(request);
    const existingFp = byKey.get(key);
    if (existingFp !== undefined) {
      strictEqual(fingerprint, existingFp, "same key, different semantics");
    } else {
      byKey.set(key, fingerprint);
    }
    const existingKey = byFingerprint.get(fingerprint);
    if (existingKey !== undefined) {
      strictEqual(key, existingKey, "same semantics, different keys");
    } else {
      byFingerprint.set(fingerprint, key);
    }
  }
});
