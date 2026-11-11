import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultPortFor,
  normalizePath,
  parseOrigin,
  pathPrefixMatch,
  resolveTargetUrl,
} from "../src/url.js";

test("defaultPortFor maps known schemes and is case-insensitive", () => {
  assert.equal(defaultPortFor("http:"), 80);
  assert.equal(defaultPortFor("HTTPS:"), 443);
  assert.equal(defaultPortFor("unknown:"), undefined);
});

test("parseOrigin fills the scheme default port", () => {
  assert.deepEqual(parseOrigin("https://shop.example.test"), {
    scheme: "https:",
    host: "shop.example.test",
    port: 443,
  });
  assert.equal(parseOrigin("http://shop.example.test:8080").port, 8080);
});

test("resolveTargetUrl handles absolute, protocol-relative and relative URLs", () => {
  const base = "https://shop.example.test/dir/page";
  assert.equal(
    resolveTargetUrl("//cdn.test/a.js", base).href,
    "https://cdn.test/a.js",
  );
  assert.equal(
    resolveTargetUrl("x.js", base).href,
    "https://shop.example.test/dir/x.js",
  );
  assert.equal(
    resolveTargetUrl("https://cdn.test/a.js", base).href,
    "https://cdn.test/a.js",
  );
});

test("normalizePath decodes once and removes dot segments", () => {
  assert.equal(normalizePath("/app%2Flib/x.js"), "/app/lib/x.js");
  assert.equal(normalizePath("/a/../b/./c"), "/b/c");
  assert.equal(normalizePath("/a/b/../../c"), "/c");
  assert.equal(normalizePath("/app/"), "/app/");
});

test("normalizePath returns null on malformed escapes", () => {
  assert.equal(normalizePath("/a%ZZ/b"), null);
  assert.equal(normalizePath("/a%2"), null);
});

test("pathPrefixMatch compares whole segments", () => {
  assert.equal(pathPrefixMatch("/app", "/app/x.js"), true);
  assert.equal(pathPrefixMatch("/app", "/apple/x.js"), false);
  assert.equal(pathPrefixMatch("/", "/anything/here"), true);
  assert.equal(pathPrefixMatch("/app/", "/app/x.js"), true);
  assert.equal(pathPrefixMatch("/app/lib", "/app"), false);
});
