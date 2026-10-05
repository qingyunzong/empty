import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  InferenceDB,
  UnstratifiedError,
  UnsafeRuleError,
  ArityError,
} from "../src/index.js";

/** Fresh full recomputation: same rules, same remaining base facts. */
function fullRecompute(rulesSrc: string, baseFacts: string[]): InferenceDB {
  const fresh = new InferenceDB();
  fresh.load(rulesSrc + "\n" + baseFacts.map((k) => k + ".").join("\n"));
  return fresh;
}

function assertSameAsFullRecompute(
  incremental: InferenceDB,
  rulesSrc: string,
  context: string
): void {
  const reference = fullRecompute(rulesSrc, incremental.baseFacts());
  assert.deepEqual(
    incremental.model(),
    reference.model(),
    `${context}: model mismatch vs full recompute`
  );
  const norm = (e: ReturnType<InferenceDB["explain"]>) =>
    e && {
      base: e.base,
      derivations: e.derivations
        .map((d) => ({ ruleId: d.ruleId, positive: d.positive, negative: d.negative }))
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    };
  for (const key of reference.factsOf()) {
    assert.deepEqual(
      norm(incremental.explain(key)),
      norm(reference.explain(key)),
      `${context}: provenance mismatch for ${key}`
    );
  }
}

const REACH_RULES = `
  reach(X) :- start(X).
  reach(Y) :- reach(X), edge(X, Y).
  unreach(X) :- node(X), not reach(X).
`;

describe("stratification", () => {
  test("accepts a stratified program and assigns increasing layers", () => {
    const db = new InferenceDB();
    db.load(`
      node(a). node(b). node(c).
      edge(a, b).
      start(a).
      ${REACH_RULES}
    `);
    const layers = db.layers();
    assert.equal(layers["edge"], 0); // EDB only
    assert.equal(layers["reach"], 1);
    assert.equal(layers["unreach"], 2); // strictly above reach (negated dep)
    assert.deepEqual(db.strataInfo(), [
      { layer: 1, preds: ["reach"] },
      { layer: 2, preds: ["unreach"] },
    ]);
  });

  test("rejects a two-predicate negative cycle with the cycle path", () => {
    const db = new InferenceDB();
    let err: unknown = null;
    try {
      db.load(`
        base(a).
        p(X) :- base(X), not q(X).
        q(X) :- base(X), not p(X).
      `);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof UnstratifiedError, "expected UnstratifiedError");
    const cycle = err.cycle;
    assert.equal(cycle[0], cycle[cycle.length - 1], "cycle must be closed");
    assert.ok(cycle.includes("p") && cycle.includes("q"));
    assert.match(err.message, /-\[not\]->/);
    console.log("    rejected cycle:", err.message);
  });

  test("rejects a negative self-cycle (win game) with the cycle path", () => {
    const db = new InferenceDB();
    assert.throws(
      () =>
        db.load(`
          move(a, b).
          win(X) :- move(X, Y), not win(Y).
        `),
      (e: unknown) => {
        assert.ok(e instanceof UnstratifiedError);
        assert.deepEqual(e.cycle, ["win", "win"]);
        return true;
      }
    );
  });

  test("rejects unsafe rules and arity mismatches", () => {
    assert.throws(() => new InferenceDB().load(`p(X) :- not q(X).`), UnsafeRuleError);
    assert.throws(() => new InferenceDB().load(`p(X) :- q(Y).`), UnsafeRuleError);
    assert.throws(
      () => new InferenceDB().load(`r(a, b). p(X) :- r(X).`),
      ArityError
    );
  });
});

describe("layered minimal model", () => {
  test("computes the minimal model layer by layer", () => {
    const db = new InferenceDB();
    db.load(`
      node(a). node(b). node(c). node(d).
      edge(a, b). edge(b, c).
      start(a).
      ${REACH_RULES}
    `);
    assert.deepEqual(db.factsOf("reach"), ["reach(a)", "reach(b)", "reach(c)"]);
    assert.deepEqual(db.factsOf("unreach"), ["unreach(d)"]);
    // Minimal model: nothing else is derived.
    assert.deepEqual(Object.keys(db.model()).sort(), [
      "edge",
      "node",
      "reach",
      "start",
      "unreach",
    ]);
  });

  test("handles three layers with negation between each", () => {
    const db = new InferenceDB();
    db.load(`
      num(1). num(2). num(3). num(4).
      step(1, 2). step(2, 3). step(3, 4).
      even(1).
      even(N) :- even(M), step(M, K), step(K, N).
      odd(N) :- num(N), not even(N).
      label(N, odd) :- odd(N).
      label(N, even) :- num(N), not odd(N).
    `);
    assert.deepEqual(db.factsOf("even"), ["even(1)", "even(3)"]);
    assert.deepEqual(db.factsOf("odd"), ["odd(2)", "odd(4)"]);
    assert.deepEqual(db.factsOf("label"), [
      "label(1,even)",
      "label(2,odd)",
      "label(3,even)",
      "label(4,odd)",
    ]);
    const layers = db.layers();
    assert.ok(layers["odd"]! > layers["even"]!);
    assert.ok(layers["label"]! > layers["odd"]!);
  });
});

describe("provenance", () => {
  test("records rule and antecedents for every derived fact", () => {
    const db = new InferenceDB();
    db.load(`
      node(a). node(b).
      edge(a, b).
      start(a).
      ${REACH_RULES}
    `);
    const exp = db.explain("reach(b)");
    assert.ok(exp);
    assert.equal(exp.base, false);
    assert.equal(exp.derivations.length, 1);
    const d = exp.derivations[0]!;
    assert.equal(d.rule, "reach(Y) :- reach(X), edge(X, Y).");
    assert.deepEqual(d.positive, ["reach(a)", "edge(a,b)"]);
    assert.deepEqual(d.negative, []);

    const neg = db.explain("unreach(b)");
    assert.equal(neg, null, "unreach(b) must not be derivable");

    const base = db.explain("edge(a,b)");
    assert.ok(base?.base);
    assert.deepEqual(base.derivations, []);
  });

  test("records negative antecedents for negated literals", () => {
    const db = new InferenceDB();
    db.load(`
      node(a). node(b).
      start(a).
      ${REACH_RULES}
    `);
    const exp = db.explain("unreach(b)");
    assert.ok(exp);
    assert.equal(exp.derivations.length, 1);
    assert.deepEqual(exp.derivations[0]!.positive, ["node(b)"]);
    assert.deepEqual(exp.derivations[0]!.negative, ["reach(b)"]);
  });
});

describe("incremental retraction", () => {
  const RULES = `
    ${REACH_RULES}
    direct(X) :- start(X).
    ok(X) :- node(X), not unreach(X).
  `;
  const EDB = `
    node(a). node(b). node(c).
    edge(a, b). edge(b, c).
    start(a).
  `;

  test("retraction removes derived facts and revives blocked negations", () => {
    const db = new InferenceDB();
    db.load(EDB + RULES);
    assert.deepEqual(db.factsOf("reach"), ["reach(a)", "reach(b)", "reach(c)"]);
    assert.deepEqual(db.factsOf("unreach"), []);
    assert.deepEqual(db.factsOf("ok"), ["ok(a)", "ok(b)", "ok(c)"]);

    assert.equal(db.retract("edge(b, c)"), true);
    assert.deepEqual(db.factsOf("reach"), ["reach(a)", "reach(b)"]);
    assert.deepEqual(db.factsOf("unreach"), ["unreach(c)"]);
    assert.deepEqual(db.factsOf("ok"), ["ok(a)", "ok(b)"]);

    assert.equal(db.retract("edge(a, b)"), true);
    assert.deepEqual(db.factsOf("reach"), ["reach(a)"]);
    assert.deepEqual(db.factsOf("unreach"), ["unreach(b)", "unreach(c)"]);
    assertSameAsFullRecompute(db, RULES, "after two retractions");
  });

  test("re-insertion clears stale negative derivations", () => {
    const db = new InferenceDB();
    db.load(EDB + RULES);
    db.retract("edge(a, b)");
    // unreach(b) and unreach(c) are now derived via `not reach(...)`.
    assert.deepEqual(db.factsOf("unreach"), ["unreach(b)", "unreach(c)"]);

    db.insert("edge(a, b)");
    // reach(b), reach(c) are derived again; unreach(b)/unreach(c) MUST be gone.
    assert.deepEqual(db.factsOf("reach"), ["reach(a)", "reach(b)", "reach(c)"]);
    assert.deepEqual(db.factsOf("unreach"), []);
    assert.deepEqual(db.factsOf("ok"), ["ok(a)", "ok(b)", "ok(c)"]);
    assertSameAsFullRecompute(db, RULES, "after re-insertion");
  });

  test("retracting a fact that has alternative derivations keeps it", () => {
    const rules = `
      p(X) :- a(X).
      p(X) :- b(X).
      q(X) :- p(X).
    `;
    const db = new InferenceDB();
    db.load(`a(1). b(1).` + rules);
    assert.deepEqual(db.factsOf("q"), ["q(1)"]);
    db.retract("a(1)");
    // p(1) still derivable via b(1); q(1) must survive.
    assert.deepEqual(db.factsOf("p"), ["p(1)"]);
    assert.deepEqual(db.factsOf("q"), ["q(1)"]);
    db.retract("b(1)");
    assert.deepEqual(db.factsOf("p"), []);
    assert.deepEqual(db.factsOf("q"), []);
    assertSameAsFullRecompute(db, rules, "after alternate-support retraction");
  });

  test("retracting a non-base fact is a no-op", () => {
    const db = new InferenceDB();
    db.load(`a(1). p(X) :- a(X).`);
    assert.equal(db.retract("p(1)"), false);
    assert.equal(db.retract("zzz(9)"), false);
    assert.deepEqual(db.factsOf("p"), ["p(1)"]);
  });
});

describe("incremental vs full recompute (randomized)", () => {
  test("random insert/retract sequences always match full recomputation", () => {
    const rules = `
      reach(X) :- start(X).
      reach(Y) :- reach(X), edge(X, Y).
      unreach(X) :- node(X), not reach(X).
      frontier(X) :- reach(X), edge(X, Y), not reach(Y).
      safe(X) :- node(X), not unreach(X).
    `;
    const nodes = ["a", "b", "c", "d", "e"];
    const allEdges: string[] = [];
    for (const x of nodes) for (const y of nodes) if (x !== y) allEdges.push(`edge(${x},${y})`);
    const allFacts = [
      ...nodes.map((n) => `node(${n})`),
      ...allEdges,
      ...nodes.map((n) => `start(${n})`),
    ];

    // Deterministic LCG so the run is reproducible.
    let seed = 0x5eed1234;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    const db = new InferenceDB();
    db.load(rules);
    let ops = 0;
    for (let step = 0; step < 120; step++) {
      const fact = allFacts[Math.floor(rand() * allFacts.length)]!;
      if (rand() < 0.5) db.insert(fact);
      else db.retract(fact);
      ops++;
      assertSameAsFullRecompute(db, rules, `step ${step}`);
    }
    console.log(`    ${ops} random insert/retract ops; model + provenance match full recompute after every op`);
    console.log(`    final model size: ${db.factsOf().length} facts, base: ${db.baseFacts().length}`);
  });
});
