import { test } from "node:test";
import * as assert from "node:assert/strict";
import { matches, includes, counterexample, relate, formatRule } from "../src/rules.js";
import {
  enumerateDomains,
  enumerateRules,
  naiveMatches,
  bruteForceIncludes,
} from "../src/enumerate.js";

// Small-label universe: alphabet {a, b}, rule depth <= 3, domain depth <= 4.
// Depth 4 is a *complete* universe for these rules: any inclusion violation
// is witnessed by a domain of depth <= ruleDepth + 1 (see enumerate.ts).
const ALPHABET = ["a", "b"];
const RULE_DEPTH = 3;
const DOMAIN_DEPTH = RULE_DEPTH + 1;

const rules = enumerateRules(ALPHABET, RULE_DEPTH); // 2 * (2+4+8) = 28
const universe = enumerateDomains(ALPHABET, DOMAIN_DEPTH); // 2+4+8+16 = 30

test("universe sizes", () => {
  assert.equal(rules.length, 28);
  assert.equal(universe.length, 30);
});

test("differential: structural matcher agrees with naive label-array matcher", () => {
  for (const rule of rules) {
    for (const d of universe) {
      assert.equal(
        matches(rule, d),
        naiveMatches(rule, d),
        `matcher disagreement: ${formatRule(rule)} vs ${d}`,
      );
    }
  }
});

test("cross-check: symbolic inclusion == brute-force inclusion on all rule pairs", () => {
  for (const a of rules) {
    for (const b of rules) {
      const symbolic = includes(a, b);
      const brute = bruteForceIncludes(a, b, universe);
      assert.equal(
        symbolic,
        brute,
        `inclusion mismatch: ${formatRule(a)} vs ${formatRule(b)}`,
      );
    }
  }
});

test("cross-check: counterexamples are valid exactly when inclusion fails", () => {
  for (const a of rules) {
    for (const b of rules) {
      const ce = counterexample(a, b);
      if (includes(a, b)) {
        assert.equal(ce, null, `unexpected counterexample for ${formatRule(a)} ⊇ ${formatRule(b)}`);
      } else {
        assert.ok(ce !== null, `missing counterexample for ${formatRule(a)} ⊉ ${formatRule(b)}`);
        assert.ok(matches(b, ce!), `counterexample ${ce} not matched by B=${formatRule(b)}`);
        assert.ok(!matches(a, ce!), `counterexample ${ce} is matched by A=${formatRule(a)}`);
        // The witness never needs more than one extra label over B's suffix.
        assert.ok(ce!.split(".").length <= RULE_DEPTH + 1, `counterexample ${ce} too deep`);
      }
    }
  }
});

test("cross-check: relation trichotomy and incomparable ⟺ disjoint", () => {
  for (const a of rules) {
    for (const b of rules) {
      const relation = relate(a, b);
      const ab = includes(a, b);
      const ba = includes(b, a);
      // relate() must agree with the inclusion flags.
      const expected = ab && ba ? "equivalent" : ab ? "includes" : ba ? "included-by" : "incomparable";
      assert.equal(relation, expected);
      // In this rule system, incomparable rules have disjoint match sets.
      const overlap = universe.some((d) => matches(a, d) && matches(b, d));
      assert.equal(relation === "incomparable", !overlap,
        `disjointness mismatch: ${formatRule(a)} vs ${formatRule(b)}`);
    }
  }
});
