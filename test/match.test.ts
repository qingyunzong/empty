import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePolicy, parseUrl } from "../src/types.js";
import { matchUrl, subdomainOf } from "../src/policy.js";

const P = (input: Parameters<typeof normalizePolicy>[0]) => normalizePolicy(input, "P");

test("subdomainOf: proper subdomains only, root excluded", () => {
  assert.equal(subdomainOf("a.example.com", "example.com"), "a");
  assert.equal(subdomainOf("a.b.example.com", "example.com"), "a.b");
  assert.equal(subdomainOf("example.com", "example.com"), null);
  assert.equal(subdomainOf("other.com", "example.com"), null);
  assert.equal(subdomainOf("notexample.com", "example.com"), null);
});

test("normalization: lowercase, strip '*.' and trailing dot, dedupe+sort", () => {
  const p = P({
    protocols: ["HTTPS", "https", "http"],
    wildcardDomains: ["*.Example.COM.", "example.com"],
    exactDomains: ["API.example.com"],
  });
  assert.deepEqual(p.protocols, ["http", "https"]);
  assert.deepEqual(
    p.entries.map((e) => `${e.kind}:${e.domain}`),
    ["exact:api.example.com", "wildcard:example.com"]
  );
});

test("wildcard matches subdomains but never the root domain", () => {
  const p = P({ protocols: ["https"], wildcardDomains: ["example.com"] });
  assert.equal(matchUrl(p, parseUrl("https://a.example.com/")), true);
  assert.equal(matchUrl(p, parseUrl("https://a.b.example.com/")), true);
  assert.equal(matchUrl(p, parseUrl("https://example.com/")), false);
});

test("exact domains match only themselves", () => {
  const p = P({ protocols: ["https"], exactDomains: ["api.example.com"] });
  assert.equal(matchUrl(p, parseUrl("https://api.example.com/")), true);
  assert.equal(matchUrl(p, parseUrl("https://www.api.example.com/")), false);
  assert.equal(matchUrl(p, parseUrl("https://example.com/")), false);
});

test("protocol and port restrictions", () => {
  const p = P({ protocols: ["https"], exactDomains: ["a.com"], ports: [8443] });
  assert.equal(matchUrl(p, parseUrl("https://a.com:8443/")), true);
  assert.equal(matchUrl(p, parseUrl("https://a.com/")), false); // default 443 not allowed
  assert.equal(matchUrl(p, parseUrl("http://a.com:8443/")), false);
  const anyPort = P({ protocols: ["https"], exactDomains: ["a.com"] });
  assert.equal(matchUrl(anyPort, parseUrl("https://a.com:1/")), true);
});

test("allow/exclude subdomain sets", () => {
  const p = P({
    protocols: ["https"],
    wildcardDomains: ["example.com"],
    allowSubdomains: ["api", "www"],
  });
  assert.equal(matchUrl(p, parseUrl("https://api.example.com/")), true);
  assert.equal(matchUrl(p, parseUrl("https://cdn.example.com/")), false);

  const q = P({
    protocols: ["https"],
    wildcardDomains: ["example.com"],
    excludeSubdomains: ["api"],
  });
  assert.equal(matchUrl(q, parseUrl("https://api.example.com/")), false);
  assert.equal(matchUrl(q, parseUrl("https://cdn.example.com/")), true);
});

test("allow set also governs exact domains via the empty subdomain", () => {
  const p = P({ protocols: ["https"], exactDomains: ["a.com"], allowSubdomains: [""] });
  assert.equal(matchUrl(p, parseUrl("https://a.com/")), true);
  const q = P({ protocols: ["https"], exactDomains: ["a.com"], allowSubdomains: ["x"] });
  assert.equal(matchUrl(q, parseUrl("https://a.com/")), false);
});

test("invalid input is rejected", () => {
  assert.throws(() => P({ protocols: [], exactDomains: ["a.com"] }));
  assert.throws(() => P({ protocols: ["https"] }));
  assert.throws(() => P({ protocols: ["https"], exactDomains: ["bad_domain!"] }));
  assert.throws(() => P({ protocols: ["https"], exactDomains: ["a.com"], ports: [0] }));
  assert.throws(() => P({ protocols: ["https"], exactDomains: ["a.com"], redirectBudget: -1 }));
});
