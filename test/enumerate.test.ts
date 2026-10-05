import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePolicy } from "../src/types.js";
import { intersectPolicies, isEmpty } from "../src/intersect.js";
import { buildUniverse, crossCheck } from "../src/enumerate.js";

const P = (input: Parameters<typeof normalizePolicy>[0], name = "P") => normalizePolicy(input, name);

function samplePolicies() {
  const a = P(
    {
      protocols: ["https", "http"],
      exactDomains: ["api.example.com"],
      wildcardDomains: ["example.com", "cdn.static.example.com"],
      ports: [443, 8080],
      allowSubdomains: ["api", "www", "v1.api"],
      excludeSubdomains: ["www"],
      redirectBudget: 2,
    },
    "A"
  );
  const b = P(
    {
      protocols: ["https"],
      wildcardDomains: ["example.com", "static.example.com"],
      exactDomains: ["api.example.com"],
      ports: [443],
      excludeSubdomains: ["evil"],
      redirectBudget: 3,
    },
    "B"
  );
  return { a, b };
}

test("small-domain enumeration confirms intersection == per-source conjunction", () => {
  const { a, b } = samplePolicies();
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  const universe = buildUniverse([a, b, r.policy]);
  assert.ok(universe.length > 100, `universe too small: ${universe.length}`);
  const check = crossCheck(a, b, r.policy, universe);
  assert.deepEqual(check.mismatches, []);
  assert.equal(check.urlsChecked, universe.length);
});

test("enumeration detects a tampered intersection", () => {
  const { a, b } = samplePolicies();
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  const universe = buildUniverse([a, b, r.policy]);

  // Drop every wildcard entry: hosts that both sources accept via
  // wildcards are now rejected by the "intersection".
  const tampered = { ...r.policy, entries: r.policy.entries.filter((e) => e.kind === "exact") };
  const check = crossCheck(a, b, tampered, universe);
  assert.ok(check.mismatches.length > 0, "tampering went unnoticed");
  assert.ok(check.mismatches.every((m) => m.sources === true && m.intersection === false));
});

test("enumeration detects a tampered port set", () => {
  const { a, b } = samplePolicies();
  const r = intersectPolicies(a, b);
  assert.equal(isEmpty(r), false);
  const universe = buildUniverse([a, b, r.policy]);
  // 8080 is in the enumerated universe (policy A allows it) but not in the
  // real intersection (policy B allows only 443).
  const tampered = { ...r.policy, ports: [443, 8080] };
  const check = crossCheck(a, b, tampered, universe);
  assert.ok(check.mismatches.length > 0, "port tampering went unnoticed");
});
