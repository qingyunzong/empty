import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import {
  Rule,
  canonicalize,
  hostMatches,
  isStrictSubdomain,
  matchUrl,
  parseRule,
  parseUrl,
} from "../src/model";

function rule(partial: Partial<Rule>): Rule {
  return {
    name: "t",
    protocols: ["https"],
    ports: [443],
    exactDomains: [],
    wildcardDomains: [],
    allowSubdomains: [],
    excludeSubdomains: [],
    maxRedirects: null,
    ...partial,
  };
}

test("wildcard matches strict subdomains but never the root domain", () => {
  const r = rule({ wildcardDomains: ["example.com"] });
  equal(hostMatches(r, "example.com"), false);
  equal(hostMatches(r, "a.example.com"), true);
  equal(hostMatches(r, "a.b.example.com"), true);
  equal(hostMatches(r, "notexample.com"), false);
  equal(hostMatches(r, "example.com.evil.org"), false);
});

test("isStrictSubdomain boundary cases", () => {
  ok(isStrictSubdomain("a.example.com", "example.com"));
  ok(!isStrictSubdomain("example.com", "example.com"));
  ok(!isStrictSubdomain("example.com", "a.example.com"));
  ok(!isStrictSubdomain("badexample.com", "example.com"));
});

test("exclusion wins over exact, allow and wildcard", () => {
  const r = rule({
    exactDomains: ["exact.example.com"],
    allowSubdomains: ["allowed.example.com"],
    wildcardDomains: ["example.com"],
    excludeSubdomains: ["exact.example.com", "allowed.example.com", "sub.example.com"],
  });
  equal(hostMatches(r, "exact.example.com"), false);
  equal(hostMatches(r, "allowed.example.com"), false);
  equal(hostMatches(r, "sub.example.com"), false);
  equal(hostMatches(r, "other.example.com"), true);
});

test("allow set adds hosts outside any wildcard", () => {
  const r = rule({ allowSubdomains: ["api.partner.net"] });
  equal(hostMatches(r, "api.partner.net"), true);
  equal(hostMatches(r, "other.partner.net"), false);
});

test("protocol and port must both match", () => {
  const r = rule({ protocols: ["https"], ports: [443, 8443], exactDomains: ["a.com"] });
  ok(matchUrl(r, { protocol: "https", host: "a.com", port: 443 }));
  ok(matchUrl(r, { protocol: "https", host: "a.com", port: 8443 }));
  ok(!matchUrl(r, { protocol: "http", host: "a.com", port: 443 }));
  ok(!matchUrl(r, { protocol: "https", host: "a.com", port: 80 }));
});

test("parseRule applies defaults and strips '*. ' wildcard prefixes", () => {
  const r = parseRule({ wildcardDomains: ["*.Example.com"] }, "mem");
  deepEqual(r.protocols, ["http", "https"]);
  deepEqual(r.ports, [80, 443]);
  deepEqual(r.wildcardDomains, ["example.com"]);
  equal(r.maxRedirects, null);
});

test("parseRule rejects invalid input", () => {
  throws(() => parseRule({ ports: [0] }, "mem"), /invalid port/);
  throws(() => parseRule({ protocols: [] }, "mem"), /non-empty/);
  throws(() => parseRule({ exactDomains: ["bad_host"] }, "mem"), /invalid host/);
  throws(() => parseRule({ maxRedirects: -1 }, "mem"), /maxRedirects/);
  throws(() => parseRule([], "mem"), /must be a JSON object/);
});

test("parseUrl normalizes case and default ports", () => {
  deepEqual(parseUrl("https://EXAMPLE.com/path?q=1"), {
    protocol: "https",
    host: "example.com",
    port: 443,
  });
  deepEqual(parseUrl("http://a.com:8080/"), { protocol: "http", host: "a.com", port: 8080 });
  throws(() => parseUrl("ftp://a.com/"), /unsupported protocol/);
});

test("canonicalize folds allows, drops redundant roots and excluded exacts", () => {
  const r = canonicalize(
    rule({
      exactDomains: ["a.example.com", "dup.com"],
      allowSubdomains: ["dup.com", "dead.example.com"],
      wildcardDomains: ["example.com", "sub.example.com"],
      excludeSubdomains: ["dead.example.com", "gone.example.com", "irrelevant.org"],
    })
  );
  // sub.example.com is subsumed by example.com; a.example.com is covered by the
  // wildcard; dead.example.com is excluded but still wildcard-covered, so its
  // exclusion must be kept; irrelevant.org cuts nothing.
  deepEqual(r.wildcardDomains, ["example.com"]);
  deepEqual(r.exactDomains, ["dup.com"]);
  deepEqual(r.excludeSubdomains, ["dead.example.com", "gone.example.com"]);
  deepEqual(r.allowSubdomains, []);
  // Matching is preserved.
  ok(!hostMatches(r, "dead.example.com"));
  ok(!hostMatches(r, "gone.example.com"));
  ok(hostMatches(r, "a.example.com"));
  ok(hostMatches(r, "dup.com"));
});
