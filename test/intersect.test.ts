import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { Rule, canonicalize, matchUrl } from "../src/model";
import { intersectRules, verifyWitness, witnessUrl } from "../src/intersect";
import { buildUniverse, crossCheckIntersection } from "../src/enumerate";

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

test("exact host intersected with covering wildcard stays exact", () => {
  const a = rule({ exactDomains: ["api.example.com"] });
  const b = rule({ wildcardDomains: ["example.com"] });
  const i = intersectRules(a, b);
  deepEqual(i.exactDomains, ["api.example.com"]);
  deepEqual(i.wildcardDomains, []);
});

test("wildcard does not cover the root: exact root x wildcard is empty", () => {
  const a = rule({ exactDomains: ["example.com"] });
  const b = rule({ wildcardDomains: ["example.com"] });
  throws(() => intersectRules(a, b), /empty intersection/);
});

test("wildcard x wildcard: nested roots keep the deeper root", () => {
  const a = rule({ wildcardDomains: ["example.com"] });
  const b = rule({ wildcardDomains: ["api.example.com"] });
  deepEqual(intersectRules(a, b).wildcardDomains, ["api.example.com"]);
  // Identical roots are kept as-is.
  deepEqual(intersectRules(a, a).wildcardDomains, ["example.com"]);
});

test("wildcard x wildcard: unrelated roots are empty", () => {
  const a = rule({ wildcardDomains: ["a.com"] });
  const b = rule({ wildcardDomains: ["b.com"] });
  throws(() => intersectRules(a, b), /empty intersection/);
});

test("exclusions from both sides subtract from the intersection", () => {
  const a = rule({ wildcardDomains: ["example.com"], excludeSubdomains: ["bad.example.com"] });
  const b = rule({ wildcardDomains: ["example.com"], excludeSubdomains: ["worse.example.com"] });
  const i = intersectRules(a, b);
  deepEqual(i.excludeSubdomains.sort(), ["bad.example.com", "worse.example.com"]);
  ok(!matchUrl(i, { protocol: "https", host: "bad.example.com", port: 443 }));
  ok(!matchUrl(i, { protocol: "https", host: "worse.example.com", port: 443 }));
  ok(matchUrl(i, { protocol: "https", host: "good.example.com", port: 443 }));
});

test("an exact host excluded by the other side disappears", () => {
  const a = rule({ exactDomains: ["a.com", "b.com"] });
  const b = rule({ exactDomains: ["a.com", "b.com"], excludeSubdomains: ["b.com"] });
  deepEqual(intersectRules(a, b).exactDomains, ["a.com"]);
});

test("allow sets participate in the intersection", () => {
  const a = rule({ allowSubdomains: ["x.io"] });
  const b = rule({ exactDomains: ["x.io", "y.io"] });
  deepEqual(intersectRules(a, b).exactDomains, ["x.io"]);
});

test("protocols and ports intersect; disjoint ones are forbidden", () => {
  const a = rule({ protocols: ["http", "https"], ports: [80, 443], exactDomains: ["a.com"] });
  const b = rule({ protocols: ["https"], ports: [443, 8443], exactDomains: ["a.com"] });
  const i = intersectRules(a, b);
  deepEqual(i.protocols, ["https"]);
  deepEqual(i.ports, [443]);
  throws(
    () => intersectRules(a, rule({ protocols: ["http"], ports: [80], exactDomains: ["nope.org"] })),
    /empty intersection/
  );
  throws(
    () => intersectRules(rule({ protocols: ["http"] }), rule({ protocols: ["https"] })),
    /no common protocol/
  );
});

test("redirect budget of the intersection is the tighter one; null propagates", () => {
  const pair = (x: number | null, y: number | null) =>
    intersectRules(
      rule({ exactDomains: ["a.com"], maxRedirects: x }),
      rule({ exactDomains: ["a.com"], maxRedirects: y })
    ).maxRedirects;
  equal(pair(2, 5), 2);
  equal(pair(null, 4), 4);
  equal(pair(3, null), 3);
  equal(pair(null, null), null);
});

test("intersection is canonical (idempotent under canonicalize)", () => {
  const a = rule({
    exactDomains: ["api.example.com"],
    wildcardDomains: ["example.com", "sub.example.com"],
    excludeSubdomains: ["bad.example.com"],
  });
  const b = rule({ wildcardDomains: ["example.com"] });
  const i = intersectRules(a, b);
  deepEqual(i, canonicalize(i));
});

const PAIRS: Array<[Rule, Rule]> = [
  [
    rule({ wildcardDomains: ["example.com"], excludeSubdomains: ["evil.example.com"], maxRedirects: 2 }),
    rule({ wildcardDomains: ["api.example.com"], allowSubdomains: ["status.example.com"], maxRedirects: 3 }),
  ],
  [
    rule({ exactDomains: ["a.com", "b.com"], ports: [80, 443], maxRedirects: 0 }),
    rule({ wildcardDomains: ["com"], allowSubdomains: ["b.com"], ports: [443], maxRedirects: 1 }),
  ],
  [
    rule({ allowSubdomains: ["x.io"], wildcardDomains: ["x.io"], excludeSubdomains: ["w.x.io"] }),
    rule({ wildcardDomains: ["io"], exactDomains: ["x.io"] }),
  ],
];

test("witness URL is accepted by both sources and the intersection", () => {
  for (const [a, b] of PAIRS) {
    const i = intersectRules(a, b);
    ok(verifyWitness(witnessUrl(i), a, b, i), `witness failed for ${i.name}`);
  }
});

test("small-domain enumeration cross-check confirms the match semantics", () => {
  for (const [a, b] of PAIRS) {
    const i = intersectRules(a, b);
    const report = crossCheckIntersection(a, b, i, buildUniverse([a, b], { maxHosts: 16, maxPorts: 3 }));
    ok(report.ok, `mismatches: ${report.mismatches.join(", ")}`);
    equal(report.mismatches.length, 0);
  }
});

test("witness for a wildcard-only intersection avoids excluded hosts", () => {
  const a = rule({ wildcardDomains: ["example.com"], excludeSubdomains: ["w.example.com", "x.example.com"] });
  const b = rule({ wildcardDomains: ["example.com"] });
  const i = intersectRules(a, b);
  const w = witnessUrl(i);
  ok(w.host !== "w.example.com" && w.host !== "x.example.com");
  ok(verifyWitness(w, a, b, i));
});
