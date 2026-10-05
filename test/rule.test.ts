import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeDomain } from "../src/domain.js";
import {
  contains,
  counterexample,
  formatRule,
  matches,
  parseRule,
  relate,
  type Rule,
} from "../src/rule.js";

function mustParse(input: string): Rule {
  const result = parseRule(input);
  assert.ok(result.ok, `expected "${input}" to parse, got: ${result.ok ? "" : result.error}`);
  return result.rule;
}

function mustReject(input: string): string {
  const result = parseRule(input);
  assert.ok(!result.ok, `expected "${input}" to be rejected`);
  return result.error;
}

describe("normalization", () => {
  test("case folding", () => {
    assert.deepEqual(normalizeDomain("ExAmPle.COM"), {
      ok: true,
      domain: "example.com",
      labels: ["example", "com"],
    });
  });

  test("single trailing dot is stripped", () => {
    const result = normalizeDomain("example.com.");
    assert.ok(result.ok && result.domain === "example.com");
  });

  test("rule parsing applies the same normalization", () => {
    const rule = mustParse("*.ExAmPle.COM.");
    assert.deepEqual(rule, { kind: "wildcard", base: "example.com" });
  });
});

describe("validation rejects", () => {
  const cases: Array<[string, RegExp]> = [
    ["", /empty/],
    [".", /root|empty/],
    ["a..com", /empty label/],
    [".example.com", /empty label/],
    ["example.com..", /empty label/],
    ["-bad.com", /hyphen/],
    ["bad-.com", /hyphen/],
    ["under_score.com", /illegal character/],
    ["white space.com", /illegal character/],
    ["percent%20enc.com", /illegal character/],
    ["1.2.3.4", /IPv4/],
    ["999.1.2.3", /IPv4/],
    ["例子.com", /non-ASCII/],
    ["exａmple.com", /non-ASCII/], // full-width a
    ["*", /bare wildcard/],
    ["*.", /bare wildcard|empty/],
    ["ex*.com", /leftmost/],
    ["a.*.com", /leftmost/],
    ["*.1.2.3.4", /IPv4/],
    [`${"a".repeat(64)}.com`, /label too long/],
  ];
  for (const [input, pattern] of cases) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      assert.match(mustReject(input), pattern);
    });
  }
});

describe("matching semantics", () => {
  test("exact rule matches only itself", () => {
    const rule = mustParse("example.com");
    assert.ok(matches(rule, "EXAMPLE.com."));
    assert.ok(!matches(rule, "a.example.com"));
    assert.ok(!matches(rule, "example.org"));
  });

  test("wildcard matches exactly one label below the base", () => {
    const rule = mustParse("*.example.com");
    assert.ok(matches(rule, "a.example.com"));
    assert.ok(matches(rule, "WWW.Example.Com."));
    assert.ok(!matches(rule, "example.com"), "apex is not matched");
    assert.ok(!matches(rule, "a.b.example.com"), "two levels are not matched");
    assert.ok(!matches(rule, "a.other.com"));
  });

  test("wildcard with multi-label base", () => {
    const rule = mustParse("*.a.b");
    assert.ok(matches(rule, "x.a.b"));
    assert.ok(!matches(rule, "a.b"));
    assert.ok(!matches(rule, "x.y.a.b"));
  });
});

describe("containment and counterexamples", () => {
  const cases: Array<[string, string, boolean, string | null]> = [
    // a, b, contains(a,b), expected counterexample when not contained
    ["example.com", "example.com", true, null],
    ["example.com", "other.com", false, "other.com"],
    ["example.com", "*.example.com", false, "x.example.com"],
    ["*.example.com", "www.example.com", true, null],
    ["*.example.com", "example.com", false, "example.com"],
    ["*.example.com", "*.example.com", true, null],
    ["*.example.com", "*.other.com", false, "x.other.com"],
    ["*.example.com", "*.a.example.com", false, "x.a.example.com"],
    ["*.a.example.com", "b.a.example.com", true, null],
    ["*.a.example.com", "*.example.com", false, "x.example.com"],
    ["a.example.com", "*.example.com", false, "x.example.com"],
  ];
  for (const [a, b, expected, ce] of cases) {
    test(`contains(${a}, ${b}) === ${expected}`, () => {
      const ra = mustParse(a);
      const rb = mustParse(b);
      assert.equal(contains(ra, rb), expected);
      const witness = counterexample(ra, rb);
      if (expected) {
        assert.equal(witness, null);
      } else {
        assert.equal(witness, ce);
        assert.ok(matches(rb, witness!), "counterexample must be matched by b");
        assert.ok(!matches(ra, witness!), "counterexample must not be matched by a");
      }
    });
  }

  test("relation classification", () => {
    assert.equal(relate(mustParse("a.com"), mustParse("a.com")), "equal");
    assert.equal(relate(mustParse("*.a.com"), mustParse("x.a.com")), "superset");
    assert.equal(relate(mustParse("x.a.com"), mustParse("*.a.com")), "subset");
    assert.equal(relate(mustParse("a.com"), mustParse("b.com")), "disjoint");
    assert.equal(relate(mustParse("*.a.com"), mustParse("*.b.com")), "disjoint");
  });
});

describe("exhaustive cross-check on small-label domains", () => {
  const ALPHABET = ["a", "b"];
  const MAX_LABELS = 3;

  function allDomains(maxLabels: number): string[] {
    const out: string[] = [];
    let level = [""];
    for (let depth = 1; depth <= maxLabels; depth++) {
      const next: string[] = [];
      for (const prefix of level) {
        for (const letter of ALPHABET) {
          const name = prefix === "" ? letter : `${letter}.${prefix}`;
          out.push(name);
          next.push(name);
        }
      }
      level = next;
    }
    return out;
  }

  // Universe: every domain of 1..MAX_LABELS labels over {a,b}.
  const universe = allDomains(MAX_LABELS);
  // Rules: exact rules over the universe, wildcard rules whose base has at
  // most MAX_LABELS-1 labels (so any witness stays inside the universe).
  const rules: Rule[] = [
    ...universe.map((d) => ({ kind: "exact", domain: d }) as Rule),
    ...allDomains(MAX_LABELS - 1).map((d) => ({ kind: "wildcard", base: d }) as Rule),
  ];

  function bruteForceContains(a: Rule, b: Rule): boolean {
    return universe.every((d) => !matches(b, d) || matches(a, d));
  }

  test("symbolic contains() agrees with brute force over the universe", () => {
    let checked = 0;
    for (const a of rules) {
      for (const b of rules) {
        const expected = bruteForceContains(a, b);
        assert.equal(
          contains(a, b),
          expected,
          `contains(${formatRule(a)}, ${formatRule(b)}) should be ${expected}`,
        );
        checked++;
      }
    }
    assert.ok(checked > 0);
  });

  test("counterexample() returns a valid witness for every non-contained pair", () => {
    for (const a of rules) {
      for (const b of rules) {
        const witness = counterexample(a, b);
        if (contains(a, b)) {
          assert.equal(witness, null);
        } else {
          assert.ok(witness !== null, `missing witness for ${formatRule(a)} vs ${formatRule(b)}`);
          assert.ok(matches(b, witness!), `${witness} must be matched by ${formatRule(b)}`);
          assert.ok(!matches(a, witness!), `${witness} must not be matched by ${formatRule(a)}`);
        }
      }
    }
  });

  test("relate() is consistent with contains() over the universe", () => {
    for (const a of rules) {
      for (const b of rules) {
        const relation = relate(a, b);
        const ab = contains(a, b);
        const ba = contains(b, a);
        const expected =
          ab && ba ? "equal" : ab ? "superset" : ba ? "subset" : "disjoint";
        assert.equal(relation, expected);
      }
    }
  });
});
