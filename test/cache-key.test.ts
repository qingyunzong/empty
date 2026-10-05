import { describe, it } from "node:test";
import {
  deepStrictEqual,
  match,
  strictEqual,
  notStrictEqual,
  throws,
} from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildCacheKey,
  CacheKeyError,
  normalizePath,
  type CacheKeyOptions,
  type HeaderLine,
  type RawRequest,
} from "../src/cache-key.js";

const VARY: CacheKeyOptions = {
  varyHeaders: ["Accept", "X-Mode", "Cookie", "Set-Cookie", "Host"],
};

function req(method: string, path: string, headers: HeaderLine[] = []): RawRequest {
  return { method, path, headers };
}

function keyOf(r: RawRequest, options: CacheKeyOptions = VARY): string {
  return buildCacheKey(r, options).key;
}

function isCacheKeyError(code: string) {
  return (err: unknown) => err instanceof CacheKeyError && err.code === code;
}

describe("method normalization", () => {
  it("case-folds method tokens", () => {
    strictEqual(keyOf(req("get", "/a")), keyOf(req("GET", "/a")));
  });

  it("rejects invalid method tokens", () => {
    throws(() => keyOf(req("GE T", "/a")), isCacheKeyError("ERR_METHOD_TOKEN"));
    throws(() => keyOf(req("", "/a")), isCacheKeyError("ERR_METHOD_TOKEN"));
  });
});

describe("path normalization", () => {
  it("removes dot segments", () => {
    strictEqual(normalizePath("/a/./b"), "/a/b");
    strictEqual(normalizePath("/a/x/../b"), "/a/b");
    strictEqual(keyOf(req("GET", "/a/./b")), keyOf(req("GET", "/a/b")));
  });

  it("decodes percent-encoded unreserved characters, any hex case", () => {
    strictEqual(normalizePath("/%7euser"), "/~user");
    strictEqual(keyOf(req("GET", "/%7Euser")), keyOf(req("GET", "/~user")));
  });

  it("uppercases hex of reserved percent-encodings without decoding", () => {
    strictEqual(normalizePath("/a%2fb"), "/a%2Fb");
    strictEqual(keyOf(req("GET", "/a%2fb")), keyOf(req("GET", "/a%2Fb")));
    notStrictEqual(keyOf(req("GET", "/a%2Fb")), keyOf(req("GET", "/a/b")));
  });

  it("decodes %2E before dot-segment removal", () => {
    strictEqual(normalizePath("/a/%2E%2E/b"), "/b");
  });

  it("treats empty path as /", () => {
    strictEqual(keyOf(req("GET", "")), keyOf(req("GET", "/")));
    strictEqual(keyOf(req("GET", "?q=1")), keyOf(req("GET", "/?q=1")));
  });

  it("keeps query parameter order and duplicates significant", () => {
    notStrictEqual(keyOf(req("GET", "/?q=1&r=2")), keyOf(req("GET", "/?r=2&q=1")));
    notStrictEqual(keyOf(req("GET", "/?q=1&q=2")), keyOf(req("GET", "/?q=1")));
  });

  it("keeps trailing slash and path case significant", () => {
    notStrictEqual(keyOf(req("GET", "/a")), keyOf(req("GET", "/a/")));
    notStrictEqual(keyOf(req("GET", "/A")), keyOf(req("GET", "/a")));
  });
});

describe("header normalization and merge rules", () => {
  it("matches field names case-insensitively", () => {
    strictEqual(
      keyOf(req("GET", "/", [["ACCEPT", "text/html"]])),
      keyOf(req("GET", "/", [["accept", "text/html"]])),
    );
  });

  it("strips optional whitespace around field values", () => {
    strictEqual(
      keyOf(req("GET", "/", [["Accept", "  text/html\t"]])),
      keyOf(req("GET", "/", [["Accept", "text/html"]])),
    );
  });

  it("merges duplicate list headers with commas", () => {
    strictEqual(
      keyOf(req("GET", "/", [["Accept", "text/html"], ["Accept", "application/json"]])),
      keyOf(req("GET", "/", [["Accept", "text/html,application/json"]])),
    );
  });

  it("merges Cookie lines with '; '", () => {
    const { audit } = buildCacheKey(
      req("GET", "/", [["Cookie", "a=1"], ["cookie", "b=2"]]),
      VARY,
    );
    deepStrictEqual(audit.usedHeaders, [["cookie", "a=1; b=2"]]);
  });

  it("keeps Set-Cookie lines as an ordered tuple (never merged)", () => {
    const { audit } = buildCacheKey(
      req("GET", "/", [["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"]]),
      VARY,
    );
    deepStrictEqual(audit.usedHeaders, [
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
    notStrictEqual(
      keyOf(req("GET", "/", [["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"]])),
      keyOf(req("GET", "/", [["Set-Cookie", "b=2"], ["Set-Cookie", "a=1"]])),
    );
  });

  it("rejects duplicates of singleton headers", () => {
    throws(
      () => keyOf(req("GET", "/", [["Host", "a"], ["host", "b"]])),
      isCacheKeyError("ERR_DUPLICATE_SINGLETON"),
    );
  });

  it("is insensitive to ordering across distinct field names", () => {
    strictEqual(
      keyOf(req("GET", "/", [["X-Mode", "1"], ["Accept", "text/html"]])),
      keyOf(req("GET", "/", [["Accept", "text/html"], ["X-Mode", "1"]])),
    );
  });
});

describe("header rejection", () => {
  it("rejects CR/LF in field values", () => {
    throws(
      () => keyOf(req("GET", "/", [["Accept", "a\r\nb"]])),
      isCacheKeyError("ERR_HEADER_NEWLINE"),
    );
    throws(
      () => keyOf(req("GET", "/", [["Accept", "a\nb"]])),
      isCacheKeyError("ERR_HEADER_NEWLINE"),
    );
    throws(
      () => keyOf(req("GET", "/", [["Accept", "a\rb"]])),
      isCacheKeyError("ERR_HEADER_NEWLINE"),
    );
  });

  it("rejects other control characters in field values", () => {
    throws(
      () => keyOf(req("GET", "/", [["Accept", "a\x07b"]])),
      isCacheKeyError("ERR_HEADER_CONTROL"),
    );
  });

  it("rejects invalid field names", () => {
    throws(
      () => keyOf(req("GET", "/", [["Bad Name", "x"]])),
      isCacheKeyError("ERR_HEADER_NAME"),
    );
    throws(
      () => keyOf(req("GET", "/", [["X\nY", "x"]])),
      isCacheKeyError("ERR_HEADER_NAME"),
    );
  });
});

describe("vary selection and audit provenance", () => {
  it("excludes non-vary headers from the key but keeps them in the audit", () => {
    const a = buildCacheKey(req("GET", "/", [["X-Trace", "t1"]]), VARY);
    const b = buildCacheKey(req("GET", "/", [["X-Trace", "t2"]]), VARY);
    strictEqual(a.key, b.key);
    deepStrictEqual(a.audit.ignoredHeaders, [["X-Trace", "t1"]]);
    deepStrictEqual(b.audit.ignoredHeaders, [["X-Trace", "t2"]]);
  });

  it("preserves original name case, value, and order of ignored headers", () => {
    const { audit } = buildCacheKey(
      req("GET", "/", [
        ["X-Trace", "  raw\tvalue  "],
        ["Accept", "text/html"],
        ["x-OTHER", "z"],
      ]),
      VARY,
    );
    deepStrictEqual(audit.ignoredHeaders, [
      ["X-Trace", "  raw\tvalue  "],
      ["x-OTHER", "z"],
    ]);
    deepStrictEqual(audit.usedHeaders, [["accept", "text/html"]]);
  });

  it("matches vary header names case-insensitively", () => {
    const { audit } = buildCacheKey(req("GET", "/", [["x-mode", "1"]]), {
      varyHeaders: ["X-MODE"],
    });
    deepStrictEqual(audit.usedHeaders, [["x-mode", "1"]]);
    deepStrictEqual(audit.ignoredHeaders, []);
  });
});

describe("key format", () => {
  it("is deterministic and self-describing", () => {
    const { key } = buildCacheKey(
      req("GET", "/a/b", [["Accept", "text/html"]]),
      VARY,
    );
    strictEqual(
      key,
      '["http-cache-key/v1","GET","/a/b",[["accept","text/html"]]]',
    );
  });

  it("digest is the SHA-256 of the canonical key", () => {
    const { key, digest } = buildCacheKey(req("GET", "/a"), VARY);
    strictEqual(digest, createHash("sha256").update(key, "utf8").digest("hex"));
    match(digest, /^[0-9a-f]{64}$/);
  });
});
