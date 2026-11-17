import assert from "node:assert/strict";
import test from "node:test";

import {
  RuleScheduler,
  expr,
  pattern,
  v,
  verifyAgainstFullRescan,
  type RewriteRule,
} from "../index.ts";

const x = v("x");
const y = v("y");

test("cyclic commutativity reaches a fixpoint with one application per fingerprint", () => {
  const commute: RewriteRule = {
    id: "and-commute",
    pattern: pattern("and", [x, y]),
    replacement: pattern("and", [y, x]),
  };
  const scheduler = new RuleScheduler({ rules: [commute] });
  const root = scheduler.add(expr("and", [expr("a"), expr("b")]));

  const first = scheduler.run();
  assert.equal(first.status, "fixpoint");
  assert.equal(first.matchesApplied, 2);
  assert.equal(first.matchesSkipped, 1);
  assert.equal(scheduler.nodesInClass(root).length, 2);
  scheduler.validate();

  const nodesAfterFirstRun = scheduler.nodeCount;
  const second = scheduler.run();
  assert.equal(second.status, "fixpoint");
  assert.equal(second.matchesApplied, 0);
  assert.equal(scheduler.nodeCount, nodesAfterFirstRun);
  scheduler.validate();
});

test("idempotence merges equivalent classes and invalidates dependent matches", () => {
  const commute: RewriteRule = {
    id: "and-commute",
    pattern: pattern("and", [x, y]),
    replacement: pattern("and", [y, x]),
  };
  const idempotence: RewriteRule = {
    id: "and-idempotent",
    pattern: pattern("and", [x, x]),
    replacement: x,
  };
  const scheduler = new RuleScheduler({ rules: [commute, idempotence] });
  const leaf = scheduler.add(expr("a"));
  const root = scheduler.add(expr("and", [expr("a"), expr("a")]));

  const stats = scheduler.run();
  assert.equal(stats.status, "fixpoint");
  assert.equal(scheduler.areEquivalent(root, leaf), true);
  assert.ok(stats.matchesInvalidated >= 1);
  assert.equal(scheduler.classOf(expr("a")), leaf);
  scheduler.validate();
});

test("adding an independent expression wakes only its local classes", () => {
  const commute: RewriteRule = {
    id: "and-commute",
    pattern: pattern("and", [x, y]),
    replacement: pattern("and", [y, x]),
  };
  const scheduler = new RuleScheduler({ rules: [commute] });

  const firstRoot = scheduler.add(
    expr("and", [expr("left"), expr("right")]),
  );
  scheduler.run();
  const classCountBefore = scheduler.classCount;

  const secondRoot = scheduler.add(
    expr("and", [expr("left"), expr("third")]),
  );
  const stats = scheduler.run();

  assert.equal(stats.status, "fixpoint");
  assert.ok(stats.classesScanned <= 4);
  assert.ok(stats.classesScanned < classCountBefore + scheduler.classCount);
  assert.equal(scheduler.areEquivalent(firstRoot, secondRoot), false);
  assert.equal(scheduler.nodesInClass(secondRoot).length, 2);
  scheduler.validate();
});

test("nested patterns enumerate every equivalent e-node alternative", () => {
  const commute: RewriteRule = {
    id: "f-commute",
    pattern: pattern("f", [x, y]),
    replacement: pattern("f", [y, x]),
  };
  const exposePair: RewriteRule = {
    id: "expose-pair",
    pattern: pattern("f", [x, y]),
    replacement: pattern("pair", [x, y]),
  };
  const scheduler = new RuleScheduler({ rules: [commute, exposePair] });
  const root = scheduler.add(expr("f", [expr("a"), expr("b")]));

  const stats = scheduler.run();
  const pairs = scheduler
    .nodesInClass(root)
    .filter((node) => node.op === "pair");

  assert.equal(stats.status, "fixpoint");
  assert.equal(pairs.length, 2);
  assert.equal(scheduler.nodesInClass(root).length, 4);
  scheduler.validate();
});

const booleanAtoms = [
  expr("a"),
  expr("b"),
  expr("true"),
  expr("false"),
] as const;

const booleanRules: readonly RewriteRule[] = [
  {
    id: "not-not",
    pattern: pattern("not", [pattern("not", [x])]),
    replacement: x,
  },
  {
    id: "not-true",
    pattern: pattern("not", [pattern("true")]),
    replacement: pattern("false"),
  },
  {
    id: "not-false",
    pattern: pattern("not", [pattern("false")]),
    replacement: pattern("true"),
  },
  {
    id: "and-commute",
    pattern: pattern("and", [x, y]),
    replacement: pattern("and", [y, x]),
  },
  {
    id: "or-commute",
    pattern: pattern("or", [x, y]),
    replacement: pattern("or", [y, x]),
  },
  {
    id: "and-idempotent",
    pattern: pattern("and", [x, x]),
    replacement: x,
  },
  {
    id: "or-idempotent",
    pattern: pattern("or", [x, x]),
    replacement: x,
  },
  {
    id: "and-true",
    pattern: pattern("and", [x, pattern("true")]),
    replacement: x,
  },
  {
    id: "and-false",
    pattern: pattern("and", [x, pattern("false")]),
    replacement: pattern("false"),
  },
  {
    id: "or-true",
    pattern: pattern("or", [x, pattern("true")]),
    replacement: pattern("true"),
  },
  {
    id: "or-false",
    pattern: pattern("or", [x, pattern("false")]),
    replacement: x,
  },
  {
    id: "and-absorption",
    pattern: pattern("and", [x, pattern("or", [x, y])]),
    replacement: x,
  },
  {
    id: "or-absorption",
    pattern: pattern("or", [x, pattern("and", [x, y])]),
    replacement: x,
  },
  {
    id: "de-morgan-in",
    pattern: pattern("not", [pattern("and", [x, y])]),
    replacement: pattern("or", [pattern("not", [x]), pattern("not", [y])]),
  },
  {
    id: "de-morgan-out",
    pattern: pattern("or", [pattern("not", [x]), pattern("not", [y])]),
    replacement: pattern("not", [pattern("and", [x, y])]),
  },
];

function enumerateBooleanTerms(): readonly ReturnType<typeof expr>[] {
  const levelOne: ReturnType<typeof expr>[] = [...booleanAtoms];
  for (const atom of booleanAtoms) levelOne.push(expr("not", [atom]));
  for (const left of booleanAtoms) {
    for (const right of booleanAtoms) {
      levelOne.push(expr("and", [left, right]));
      levelOne.push(expr("or", [left, right]));
    }
  }
  const terms = new Set<ReturnType<typeof expr>>(levelOne);
  for (const term of levelOne) {
    terms.add(expr("not", [term]));
    for (const atom of booleanAtoms) {
      terms.add(expr("and", [term, atom]));
      terms.add(expr("or", [term, atom]));
      terms.add(expr("and", [atom, term]));
      terms.add(expr("or", [atom, term]));
    }
  }
  return [...terms];
}

test("finite Boolean algebra agrees with a full rescan for every seed", () => {
  const seeds = enumerateBooleanTerms();
  for (const seed of seeds) {
    const comparison = verifyAgainstFullRescan([seed], booleanRules, {
      maxIterations: 1_000,
      maxNodes: 20_000,
    });
    assert.equal(
      comparison.equal,
      true,
      `incremental/full-rescan mismatch for ${JSON.stringify(seed)}`,
    );
    assert.equal(comparison.incrementalStats.status, "fixpoint");
    assert.equal(comparison.fullRescanStats.status, "fixpoint");
  }
});
