import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePolicy, parseUrl } from "../src/types.js";
import { intersectPolicies, isEmpty } from "../src/intersect.js";
import { buildUniverse } from "../src/enumerate.js";
import {
  conjunctionAcceptor,
  policyAcceptor,
  shortestDifferingChain,
  verifyRedirectEquivalence,
} from "../src/chains.js";

const P = (input: Parameters<typeof normalizePolicy>[0], name = "P") => normalizePolicy(input, name);

function boundedPolicies() {
  const a = P(
    { protocols: ["https"], wildcardDomains: ["example.com"], redirectBudget: 2 },
    "A"
  );
  const b = P(
    { protocols: ["https"], wildcardDomains: ["shop.example.com"], ports: [443], redirectBudget: 3 },
    "B"
  );
  return { a, b };
}

test("bounded budgets: finite-state equivalence proof is produced", () => {
  const { a, b } = boundedPolicies();
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  const universe = buildUniverse([a, b, r.policy]);
  const verdict = verifyRedirectEquivalence(a, b, r.policy, universe);
  assert.equal(verdict.status, "equivalent");
  if (verdict.status === "equivalent") {
    assert.equal(verdict.proof.budget, 2);
    assert.equal(verdict.proof.perHopPredicatesAgree, true);
    assert.equal(verdict.proof.budgetsEqual, true);
    assert.ok(verdict.proof.chainsEnumerated > 0);
  }
});

test("unbounded budget on both sides: verdict is unknown (model cannot be closed)", () => {
  const a = P({ protocols: ["https"], wildcardDomains: ["example.com"] }, "A");
  const b = P({ protocols: ["https"], wildcardDomains: ["example.com"] }, "B");
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  const universe = buildUniverse([a, b, r.policy]);
  const verdict = verifyRedirectEquivalence(a, b, r.policy, universe);
  assert.equal(verdict.status, "unknown");
});

test("one bounded side closes the model: min budget governs", () => {
  const a = P({ protocols: ["https"], wildcardDomains: ["example.com"] }, "A");
  const b = P({ protocols: ["https"], wildcardDomains: ["example.com"], redirectBudget: 2 }, "B");
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  const universe = buildUniverse([a, b, r.policy]);
  const verdict = verifyRedirectEquivalence(a, b, r.policy, universe);
  assert.equal(verdict.status, "equivalent");
  if (verdict.status === "equivalent") assert.equal(verdict.proof.budget, 2);
});

test("tampered budget: shortest differently-accepted chain sits at the budget boundary", () => {
  const { a, b } = boundedPolicies();
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  // Conjunction budget is min(2,3)=2; pretend the intersection allows 3.
  const tampered = { ...r.policy, redirectBudget: 3 };
  const universe = buildUniverse([a, b, tampered]);
  const verdict = verifyRedirectEquivalence(a, b, tampered, universe);
  assert.equal(verdict.status, "different");
  if (verdict.status === "different") {
    assert.equal(verdict.shortestChain.length, 4); // 3 redirects = min(2,3) + 1
    assert.equal(verdict.acceptedByIntersection, true);
  }
});

test("tampered predicate: shortest differing chain is a single URL", () => {
  const { a, b } = boundedPolicies();
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  const tampered = {
    ...r.policy,
    entries: [...r.policy.entries, { kind: "exact" as const, domain: "evil.com", allow: null, exclude: [] }],
  };
  const universe = buildUniverse([a, b, tampered]);
  const verdict = verifyRedirectEquivalence(a, b, tampered, universe);
  assert.equal(verdict.status, "different");
  if (verdict.status === "different") {
    assert.equal(verdict.shortestChain.length, 1);
    assert.equal(verdict.shortestChain[0], "https://evil.com/");
    assert.equal(verdict.acceptedByIntersection, true);
  }
});

test("shortestDifferingChain: budget-only difference needs min+1 redirects", () => {
  const base = P({ protocols: ["https"], exactDomains: ["a.com"], redirectBudget: 1 }, "X");
  const other = P({ protocols: ["https"], exactDomains: ["a.com"], redirectBudget: 5 }, "Y");
  const universe = buildUniverse([base, other]);
  const chain = shortestDifferingChain(policyAcceptor(base), policyAcceptor(other), universe);
  assert.ok(chain);
  assert.equal(chain!.length, 3); // 2 redirects = min(1,5) + 1
});

test("chain acceptance counts redirects, not URLs", () => {
  const p = P({ protocols: ["https"], exactDomains: ["a.com"], redirectBudget: 1 }, "P");
  const acc = conjunctionAcceptor(p, p);
  const u = parseUrl("https://a.com/");
  assert.equal(acc.accept([u]), true); // 0 redirects
  assert.equal(acc.accept([u, u]), true); // 1 redirect
  assert.equal(acc.accept([u, u, u]), false); // 2 redirects > budget
});
