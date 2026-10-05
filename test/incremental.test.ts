import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, loadProgram } from "../src/engine.js";

const REACH_RULES = `
  reachable(X) :- start(X).
  reachable(Y) :- reachable(X), edge(X, Y).
  blocked(X) :- node(X), not reachable(X).
`;

function reachEngine(): Engine {
  return loadProgram(REACH_RULES, [
    `node("a").`, `node("b").`, `node("c").`, `node("d").`,
    `start("a").`,
    `edge("a", "b").`, `edge("b", "c").`,
  ]);
}

test("retracting a fact cascades through positive derivations", () => {
  const engine = reachEngine();
  assert.deepEqual(engine.query("reachable"), [["a"], ["b"], ["c"]]);
  engine.retractFact("edge", "a", "b");
  assert.deepEqual(engine.query("reachable"), [["a"]]);
  // b and c became unreachable, so the negation-based rule now fires.
  assert.deepEqual(engine.query("blocked"), [["b"], ["c"], ["d"]]);
});

test("re-adding a fact removes stale negation-based conclusions", () => {
  const engine = reachEngine();
  engine.retractFact("edge", "a", "b");
  assert.deepEqual(engine.query("blocked"), [["b"], ["c"], ["d"]]);
  engine.addFact("edge", "a", "b");
  // blocked("b") / blocked("c") must not survive as stale derivations.
  assert.deepEqual(engine.query("blocked"), [["d"]]);
  assert.deepEqual(engine.query("reachable"), [["a"], ["b"], ["c"]]);
  assert.deepEqual(engine.why("blocked", "b"), []);
  assert.deepEqual(engine.why("blocked", "c"), []);
});

test("retracting the root of a chain updates every stratum", () => {
  const engine = reachEngine();
  engine.retractFact("start", "a");
  assert.deepEqual(engine.query("reachable"), []);
  assert.deepEqual(engine.query("blocked"), [["a"], ["b"], ["c"], ["d"]]);
  engine.addFact("start", "a");
  assert.deepEqual(engine.query("reachable"), [["a"], ["b"], ["c"]]);
  assert.deepEqual(engine.query("blocked"), [["d"]]);
});

test("a fact with alternative derivations survives partial retraction", () => {
  const engine = loadProgram(
    `
    reachable(X) :- start(X).
    reachable(Y) :- reachable(X), edge(X, Y).
    `,
    [`start("a").`, `start("b").`, `edge("a", "c").`, `edge("b", "c").`],
  );
  assert.equal(engine.why("reachable", "c").length, 2);
  engine.retractFact("start", "a");
  // Still reachable via start("b"); exactly one derivation remains.
  assert.deepEqual(engine.query("reachable"), [["b"], ["c"]]);
  const derivs = engine.why("reachable", "c");
  assert.equal(derivs.length, 1);
  assert.deepEqual(derivs[0]!.pos, [`reachable("b")`, `edge("b","c")`]);
});

test("inserting a fact invalidates negation-based conclusions", () => {
  const engine = reachEngine();
  assert.deepEqual(engine.query("blocked"), [["d"]]);
  engine.addFact("edge", "c", "d");
  // d is reachable now, so blocked("d") must be gone.
  assert.deepEqual(engine.query("reachable"), [["a"], ["b"], ["c"], ["d"]]);
  assert.deepEqual(engine.query("blocked"), []);
  assert.deepEqual(engine.why("blocked", "d"), []);
});

test("three-stratum ripple: deletion then re-derivation across layers", () => {
  const engine = loadProgram(
    `
    p(X) :- base(X), pick(X).
    q(X) :- base(X), not p(X).
    r(X) :- base(X), not q(X).
    `,
    [`base(1).`, `base(2).`, `pick(2).`],
  );
  assert.deepEqual(engine.query("p"), [[2]]);
  assert.deepEqual(engine.query("q"), [[1]]);
  assert.deepEqual(engine.query("r"), [[2]]);

  engine.retractFact("pick", 2);
  assert.deepEqual(engine.query("p"), []);
  assert.deepEqual(engine.query("q"), [[1], [2]]);
  assert.deepEqual(engine.query("r"), []);

  engine.addFact("pick", 2);
  assert.deepEqual(engine.query("p"), [[2]]);
  assert.deepEqual(engine.query("q"), [[1]]);
  assert.deepEqual(engine.query("r"), [[2]]);
});

test("retracting an absent fact is a no-op", () => {
  const engine = reachEngine();
  const before = engine.snapshot();
  assert.equal(engine.retractFact("edge", "a", "c"), false);
  assert.equal(engine.retractFact("node", "zzz"), false);
  assert.deepEqual(engine.snapshot(), before);
});

test("re-adding an existing fact is a no-op", () => {
  const engine = reachEngine();
  const before = engine.snapshot();
  assert.equal(engine.addFact("start", "a"), false);
  assert.deepEqual(engine.snapshot(), before);
});

test("provenance follows retractions precisely", () => {
  const engine = reachEngine();
  engine.retractFact("edge", "a", "b");
  // reachable("c") lost its only derivation chain.
  assert.deepEqual(engine.why("reachable", "c"), []);
  assert.deepEqual(engine.why("reachable", "b"), []);
  // blocked("b") is now derivable; its provenance cites the absence.
  const d = engine.why("blocked", "b");
  assert.equal(d.length, 1);
  assert.deepEqual(d[0]!.neg, [`reachable("b")`]);
});

test("derived facts keep an EDB fact alive after retraction", () => {
  // A fact that is both asserted and derived stays true when retracted,
  // because its derivation still justifies it.
  const engine = loadProgram(`p(X) :- base(X).`, [`base(1).`, `p(1).`]);
  assert.deepEqual(engine.query("p"), [[1]]);
  engine.retractFact("p", 1);
  assert.deepEqual(engine.query("p"), [[1]]); // still derived from base(1)
  engine.retractFact("base", 1);
  assert.deepEqual(engine.query("p"), []);
});

test("incremental state matches a full recompute after every step", () => {
  const engine = reachEngine();
  const ops: Array<() => void> = [
    () => engine.retractFact("edge", "a", "b"),
    () => engine.retractFact("start", "a"),
    () => engine.addFact("edge", "c", "d"),
    () => engine.addFact("start", "b"),
    () => engine.retractFact("edge", "b", "c"),
    () => engine.addFact("edge", "a", "d"),
  ];
  for (const op of ops) {
    op();
    const incremental = engine.snapshot();
    engine.recompute();
    assert.deepEqual(engine.snapshot(), incremental);
  }
});

test("circular self-support does not survive retraction (DRed over-delete)", () => {
  // p("c") is grounded by e0("a"), but also has the circular derivation
  // p("c") :- p("c"), not e0("c"). Retracting e0("a") must eliminate it:
  // a derivation may not be its own support.
  const engine = loadProgram(
    `
    p("c") :- e0("a").
    p(Z) :- p(Z), not e0(Z).
    `,
    [`e0("a").`],
  );
  assert.deepEqual(engine.query("p"), [["c"]]);
  assert.equal(engine.why("p", "c").length, 2);
  engine.retractFact("e0", "a");
  assert.deepEqual(engine.query("p"), []);
  assert.deepEqual(engine.why("p", "c"), []);
  const incremental = engine.snapshot();
  engine.recompute();
  assert.deepEqual(engine.snapshot(), incremental);
});

test("mutually recursive derivations collapse together", () => {
  // q and r support each other in a positive cycle; once the base fact is
  // gone the whole cycle must disappear.
  const engine = loadProgram(
    `
    q(X) :- base(X).
    q(X) :- r(X).
    r(X) :- q(X).
    s(X) :- node(X), not q(X).
    `,
    [`base(1).`, `node(1).`, `node(2).`],
  );
  assert.deepEqual(engine.query("q"), [[1]]);
  assert.deepEqual(engine.query("r"), [[1]]);
  assert.deepEqual(engine.query("s"), [[2]]);
  engine.retractFact("base", 1);
  assert.deepEqual(engine.query("q"), []);
  assert.deepEqual(engine.query("r"), []);
  assert.deepEqual(engine.query("s"), [[1], [2]]);
  const incremental = engine.snapshot();
  engine.recompute();
  assert.deepEqual(engine.snapshot(), incremental);
});
