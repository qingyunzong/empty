import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProgram } from "../src/engine.js";

test("transitive closure computes the minimal model", () => {
  const engine = loadProgram(
    `
    path(X, Y) :- edge(X, Y).
    path(X, Z) :- path(X, Y), edge(Y, Z).
    `,
    [
      `edge("a", "b").`,
      `edge("b", "c").`,
      `edge("c", "d").`,
      `edge("d", "b").`, // cycle: must still terminate
    ],
  );
  assert.deepEqual(engine.query("path"), [
    ["a", "b"],
    ["a", "c"],
    ["a", "d"],
    ["b", "b"],
    ["b", "c"],
    ["b", "d"],
    ["c", "b"],
    ["c", "c"],
    ["c", "d"],
    ["d", "b"],
    ["d", "c"],
    ["d", "d"],
  ]);
});

test("stratified negation sees the completed lower stratum", () => {
  const engine = loadProgram(
    `
    reachable(X) :- start(X).
    reachable(Y) :- reachable(X), edge(X, Y).
    blocked(X) :- node(X), not reachable(X).
    `,
    [
      `node("a").`, `node("b").`, `node("c").`, `node("d").`,
      `start("a").`,
      `edge("a", "b").`, `edge("b", "c").`,
    ],
  );
  assert.deepEqual(engine.query("reachable"), [["a"], ["b"], ["c"]]);
  assert.deepEqual(engine.query("blocked"), [["d"]]);
});

test("three-layer negation alternates as expected", () => {
  // scc-free chain: layer1 p, layer2 q = not p, layer3 r = not q.
  const engine = loadProgram(
    `
    p(X) :- base(X), limit(X).
    q(X) :- base(X), not p(X).
    r(X) :- base(X), not q(X).
    `,
    [`base(1).`, `base(2).`, `limit(2).`],
  );
  assert.deepEqual(engine.query("p"), [[2]]);
  assert.deepEqual(engine.query("q"), [[1]]);
  assert.deepEqual(engine.query("r"), [[2]]);
});

test("provenance records rule, positive support and negative support", () => {
  const engine = loadProgram(
    `
    reachable(X) :- start(X).
    blocked(X) :- node(X), not reachable(X).
    `,
    [`node("a").`, `node("b").`, `start("a").`],
  );
  const derivs = engine.why("blocked", "b");
  assert.equal(derivs.length, 1);
  const d = derivs[0]!;
  assert.equal(d.ruleText, "blocked(X) :- node(X), not reachable(X).");
  assert.deepEqual(d.pos, [`node("b")`]);
  assert.deepEqual(d.neg, [`reachable("b")`]);
  // A fact that is false has no derivations.
  assert.deepEqual(engine.why("blocked", "a"), []);
});

test("multiple derivations of the same fact are all recorded", () => {
  const engine = loadProgram(
    `
    reachable(X) :- start(X).
    reachable(Y) :- reachable(X), edge(X, Y).
    `,
    [`start("a").`, `start("b").`, `edge("a", "c").`, `edge("b", "c").`],
  );
  const derivs = engine.why("reachable", "c");
  assert.equal(derivs.length, 2);
  const supports = derivs.map((d) => d.pos[0]).sort();
  assert.deepEqual(supports, [`reachable("a")`, `reachable("b")`]);
});

test("numeric and symbolic constants share the domain", () => {
  const engine = loadProgram(
    `sq(X, Y) :- num(X), square(X, Y).`,
    [`num(1).`, `num(2).`, `square(1, 1).`, `square(2, 4).`],
  );
  assert.deepEqual(engine.query("sq"), [[1, 1], [2, 4]]);
});

test("anonymous variables and constants in rule bodies", () => {
  const engine = loadProgram(
    `
    hasEdge(X) :- edge(X, _).
    selfLoop(X) :- edge(X, X).
    toB(X) :- edge(X, "b").
    `,
    [`edge("a", "b").`, `edge("c", "c").`],
  );
  assert.deepEqual(engine.query("hasEdge"), [["a"], ["c"]]);
  assert.deepEqual(engine.query("selfLoop"), [["c"]]);
  assert.deepEqual(engine.query("toB"), [["a"]]);
});
