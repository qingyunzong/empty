import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { Rule, UrlParts } from "../src/model";
import { intersectRules } from "../src/intersect";
import {
  acceptsChain,
  checkEquivalence,
  crossCheckChainIntersection,
} from "../src/chains";
import { buildUniverse } from "../src/enumerate";

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

const U = (host: string): UrlParts => ({ protocol: "https", host, port: 443 });

test("acceptsChain enforces the budget and per-hop matching", () => {
  const r = rule({ wildcardDomains: ["example.com"], maxRedirects: 1 });
  ok(acceptsChain(r, [U("a.example.com")]));
  ok(acceptsChain(r, [U("a.example.com"), U("b.example.com")]));
  ok(!acceptsChain(r, [U("a.example.com"), U("b.example.com"), U("c.example.com")]));
  ok(!acceptsChain(r, [U("a.example.com"), U("other.org")]));
  ok(!acceptsChain(r, []));
  // Unclosed budget accepts any length.
  const open = rule({ wildcardDomains: ["example.com"], maxRedirects: null });
  ok(acceptsChain(open, Array(50).fill(U("a.example.com"))));
});

test("identical policies are equivalent and yield a finite-state proof", () => {
  const a = rule({ wildcardDomains: ["example.com"], excludeSubdomains: ["evil.example.com"], maxRedirects: 2 });
  const result = checkEquivalence(a, rule({ wildcardDomains: ["example.com"], excludeSubdomains: ["evil.example.com"], maxRedirects: 2 }));
  equal(result.kind, "equivalent");
  if (result.kind !== "equivalent") return;
  equal(result.proof.budget, 2);
  ok(result.proof.matchPredicateEqual);
  ok(result.proof.urlCrossCheck.ok);
  ok(result.proof.chainCrossCheck.ok);
  ok(result.proof.chainCrossCheck.chainsChecked > 0);
  ok(result.proof.automaton.states.includes("q2"));
  ok(result.proof.automaton.states.includes("dead"));
});

test("syntactically different but semantically equal policies are equivalent", () => {
  const a = rule({
    exactDomains: ["api.example.com"],
    allowSubdomains: ["status.example.com"],
    wildcardDomains: ["example.com", "sub.example.com"],
    maxRedirects: 1,
  });
  const b = rule({
    allowSubdomains: ["api.example.com", "status.example.com"],
    wildcardDomains: ["example.com"],
    maxRedirects: 1,
  });
  equal(checkEquivalence(a, b).kind, "equivalent");
});

test("different match sets: shortest separator is a 0-redirect chain", () => {
  const a = rule({ wildcardDomains: ["example.com"], maxRedirects: 2 });
  const b = rule({ wildcardDomains: ["example.com"], excludeSubdomains: ["w.example.com"], maxRedirects: 2 });
  const result = checkEquivalence(a, b);
  equal(result.kind, "not-equivalent");
  if (result.kind !== "not-equivalent") return;
  equal(result.redirects, 0);
  equal(result.distinguishingChain.length, 1);
  equal(result.acceptedBy, "A");
  const hop = result.distinguishingChain[0];
  if (hop === undefined) throw new Error("expected a distinguishing hop");
  ok(acceptsChain(a, [hop]) && !acceptsChain(b, [hop]));
  // Enumeration confirms nothing diverges at shorter length (none exists).
  equal(result.chainCrossCheck.firstDivergenceLength, 1);
});

test("different budgets: shortest separator has min(budget)+1 redirects", () => {
  const a = rule({ wildcardDomains: ["example.com"], maxRedirects: 1 });
  const b = rule({ wildcardDomains: ["example.com"], maxRedirects: 3 });
  const result = checkEquivalence(a, b);
  equal(result.kind, "not-equivalent");
  if (result.kind !== "not-equivalent") return;
  equal(result.redirects, 2);
  equal(result.distinguishingChain.length, 3);
  equal(result.acceptedBy, "B");
  ok(acceptsChain(b, result.distinguishingChain));
  ok(!acceptsChain(a, result.distinguishingChain));
  // Every hop is accepted by both policies individually.
  for (const hop of result.distinguishingChain) {
    ok(acceptsChain(a, [hop]) && acceptsChain(b, [hop]));
  }
  // Full-chain enumeration finds the first divergence exactly at length 3.
  equal(result.chainCrossCheck.firstDivergenceLength, 3);
});

test("unclosed budget returns unknown", () => {
  const a = rule({ wildcardDomains: ["example.com"], maxRedirects: null });
  const b = rule({ wildcardDomains: ["example.com"], maxRedirects: 2 });
  const result = checkEquivalence(a, b);
  equal(result.kind, "unknown");
  if (result.kind === "unknown") ok(/unclosed redirect budget/.test(result.reason));
  const both = checkEquivalence(a, rule({ maxRedirects: null }));
  equal(both.kind, "unknown");
});

test("empty-host policies reject every chain and are equivalent", () => {
  const a = rule({ maxRedirects: 1 });
  const b = rule({ maxRedirects: 5 });
  equal(checkEquivalence(a, b).kind, "equivalent");
});

test("intersection satisfies both policies at every hop (full-chain enumeration)", () => {
  const a = rule({
    wildcardDomains: ["example.com"],
    excludeSubdomains: ["evil.example.com"],
    maxRedirects: 2,
  });
  const b = rule({
    wildcardDomains: ["api.example.com"],
    allowSubdomains: ["status.example.com"],
    maxRedirects: 3,
  });
  const i = intersectRules(a, b);
  const universe = buildUniverse([a, b], { maxHosts: 6, maxPorts: 2 });
  const report = crossCheckChainIntersection(a, b, i, universe, 2);
  ok(report.ok, `first divergence at chain length ${report.firstDivergenceLength}`);
  ok(report.chainsChecked > 200);
});
