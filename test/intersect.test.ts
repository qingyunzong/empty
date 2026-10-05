import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePolicy, parseUrl } from "../src/types.js";
import { matchUrl } from "../src/policy.js";
import { intersectPolicies, isEmpty, witnessUrl } from "../src/intersect.js";

const P = (input: Parameters<typeof normalizePolicy>[0], name = "P") => normalizePolicy(input, name);

test("wildcard x wildcard keeps the deeper base", () => {
  const a = P({ protocols: ["https"], wildcardDomains: ["example.com"] }, "A");
  const b = P({ protocols: ["https"], wildcardDomains: ["shop.example.com"] }, "B");
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  assert.deepEqual(
    r.policy.entries.map((e) => `${e.kind}:${e.domain}`),
    ["wildcard:shop.example.com"]
  );
  assert.equal(matchUrl(r.policy, parseUrl("https://x.shop.example.com/")), true);
  assert.equal(matchUrl(r.policy, parseUrl("https://shop.example.com/")), false);
  assert.equal(matchUrl(r.policy, parseUrl("https://other.example.com/")), false);
});

test("exact x wildcard keeps the exact host when it is a proper subdomain", () => {
  const a = P({ protocols: ["https"], exactDomains: ["a.b.example.com"] }, "A");
  const b = P({ protocols: ["https"], wildcardDomains: ["b.example.com"] }, "B");
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  assert.deepEqual(
    r.policy.entries.map((e) => `${e.kind}:${e.domain}`),
    ["exact:a.b.example.com"]
  );
});

test("exact host equal to the wildcard root is NOT intersected (root excluded)", () => {
  const a = P({ protocols: ["https"], exactDomains: ["example.com"] }, "A");
  const b = P({ protocols: ["https"], wildcardDomains: ["example.com"] }, "B");
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), true);
  assert.deepEqual(r.emptyReasons, ["no viable domain rule survives the intersection"]);
});

test("incomparable wildcards give an empty intersection", () => {
  const a = P({ protocols: ["https"], wildcardDomains: ["a.com"] }, "A");
  const b = P({ protocols: ["https"], wildcardDomains: ["b.com"] }, "B");
  assert.equal(isEmpty(intersectPolicies(a, b)), true);
});

test("disjoint protocols and ports are reported explicitly", () => {
  const a = P({ protocols: ["https"], exactDomains: ["a.com"], ports: [443] }, "A");
  const b = P({ protocols: ["http"], exactDomains: ["a.com"], ports: [80] }, "B");
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), true);
  assert.ok(r.emptyReasons.includes("protocols are disjoint"));
  assert.ok(r.emptyReasons.includes("ports are disjoint"));
});

test("allow sets intersect, exclude sets union", () => {
  const a = P(
    { protocols: ["https"], wildcardDomains: ["example.com"], allowSubdomains: ["api", "www"] },
    "A"
  );
  const b = P(
    { protocols: ["https"], wildcardDomains: ["example.com"], allowSubdomains: ["www", "shop"], excludeSubdomains: ["shop"] },
    "B"
  );
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  const entry = r.policy.entries[0]!;
  assert.deepEqual(entry.allow, ["www"]);
  assert.deepEqual(entry.exclude, ["shop"]);
  assert.equal(matchUrl(r.policy, parseUrl("https://www.example.com/")), true);
  assert.equal(matchUrl(r.policy, parseUrl("https://api.example.com/")), false);
  assert.equal(matchUrl(r.policy, parseUrl("https://shop.example.com/")), false);
});

test("allow sets are shifted when the deeper wildcard base wins", () => {
  const a = P(
    { protocols: ["https"], wildcardDomains: ["example.com"], allowSubdomains: ["a.b"] },
    "A"
  );
  const b = P({ protocols: ["https"], wildcardDomains: ["b.example.com"] }, "B");
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  const entry = r.policy.entries[0]!;
  assert.equal(entry.domain, "b.example.com");
  assert.deepEqual(entry.allow, ["a"]);
  assert.equal(matchUrl(r.policy, parseUrl("https://a.b.example.com/")), true);
  assert.equal(matchUrl(r.policy, parseUrl("https://x.b.example.com/")), false);
});

test("wildcard intersection is empty when the combined allow set has no usable subdomain", () => {
  const a = P({ protocols: ["https"], wildcardDomains: ["example.com"], allowSubdomains: [""] }, "A");
  const b = P({ protocols: ["https"], wildcardDomains: ["example.com"] }, "B");
  assert.equal(isEmpty(intersectPolicies(a, b)), true);
});

test("redirect budget is the minimum, null means unbounded", () => {
  const mk = (budget: number | null, name: string) =>
    P({ protocols: ["https"], exactDomains: ["a.com"], redirectBudget: budget }, name);
  assert.equal(intersectPolicies(mk(2, "A"), mk(3, "B")).policy.redirectBudget, 2);
  assert.equal(intersectPolicies(mk(null, "A"), mk(3, "B")).policy.redirectBudget, 3);
  assert.equal(intersectPolicies(mk(null, "A"), mk(null, "B")).policy.redirectBudget, null);
});

test("witness URL satisfies the intersection and both sources", () => {
  const a = P(
    {
      protocols: ["https"],
      exactDomains: ["api.example.com"],
      wildcardDomains: ["example.com"],
      allowSubdomains: ["api", "www"],
      redirectBudget: 2,
    },
    "A"
  );
  const b = P(
    {
      protocols: ["https", "http"],
      wildcardDomains: ["example.com"],
      ports: [443],
      excludeSubdomains: ["www"],
      redirectBudget: 3,
    },
    "B"
  );
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  const w = witnessUrl(r, a, b);
  assert.equal(w, "https://api.example.com/");
  const parts = parseUrl(w);
  assert.equal(matchUrl(r.policy, parts), true);
  assert.equal(matchUrl(a, parts), true);
  assert.equal(matchUrl(b, parts), true);
});
