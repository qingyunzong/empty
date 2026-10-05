import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.js";
import { compile, CompileError } from "../src/compile.js";
import { parseRules, resetRuleCounterForTests } from "../src/parser.js";

function compileText(src: string) {
  resetRuleCounterForTests();
  return compile(parseRules(src));
}

test("stratification assigns layers by dependency depth", () => {
  const program = compileText(`
    reachable(X) :- start(X).
    reachable(Y) :- reachable(X), edge(X, Y).
    blocked(X) :- node(X), not reachable(X).
    free(X) :- node(X), not blocked(X).
  `);
  assert.equal(program.predStratum.get("start"), 0); // EDB-only
  assert.equal(program.predStratum.get("edge"), 0);
  assert.equal(program.predStratum.get("reachable"), 1);
  assert.equal(program.predStratum.get("blocked"), 2);
  assert.equal(program.predStratum.get("free"), 3);
  assert.equal(program.strata.length, 4);
  assert.equal(program.strata[1]!.length, 2); // both reachable rules
  assert.equal(program.strata[2]!.length, 1);
  assert.equal(program.strata[3]!.length, 1);
});

test("mutually recursive positive rules share one stratum", () => {
  const program = compileText(`
    p(X) :- q(X).
    q(X) :- p(X), base(X).
  `);
  assert.equal(program.predStratum.get("p"), 1);
  assert.equal(program.predStratum.get("q"), 1);
});

test("negative self-cycle is rejected with the cycle path", () => {
  assert.throws(
    () => compileText(`p(X) :- base(X), not p(X).`),
    (err: unknown) => {
      assert.ok(err instanceof CompileError);
      assert.match((err as Error).message, /negative dependency cycle p -> p/);
      return true;
    },
  );
});

test("two-predicate negative cycle reports the full path", () => {
  assert.throws(
    () =>
      compileText(`
        p(X) :- base(X), not q(X).
        q(X) :- base(X), not p(X).
      `),
    /negative dependency cycle (p -> q -> p|q -> p -> q)/,
  );
});

test("longer negative cycle reports every hop", () => {
  assert.throws(
    () =>
      compileText(`
        a(X) :- base(X), not b(X).
        b(X) :- c(X).
        c(X) :- d(X).
        d(X) :- base(X), not a(X).
      `),
    /negative dependency cycle a -> b -> c -> d -> a/,
  );
});

test("negation through a positive-only cycle is still rejected", () => {
  // p and q are positively recursive, and p also depends negatively on q:
  // the negative edge stays inside the SCC {p, q}.
  assert.throws(
    () =>
      compileText(`
        p(X) :- q(X).
        q(X) :- p(X).
        p(X) :- base(X), not q(X).
      `),
    /negative dependency cycle (p -> q -> p|q -> p -> q)/,
  );
});

test("legal stratified negation across layers is accepted", () => {
  const program = compileText(`
    p(X) :- base(X).
    q(X) :- base(X), not p(X).
    r(X) :- base(X), not q(X).
  `);
  assert.equal(program.predStratum.get("q"), 2);
  assert.equal(program.predStratum.get("r"), 3);
});

test("unsafe rules are rejected (unbound head / negative variables)", () => {
  assert.throws(() => compileText(`p(X) :- q(Y).`), /unsafe rule/);
  assert.throws(() => compileText(`p(X) :- not q(X).`), /unsafe rule/);
  assert.throws(
    () => compileText(`p(X) :- a(X), not q(Y).`),
    /unsafe rule.*'Y'.*negative literal/,
  );
});

test("arity mismatches are rejected", () => {
  assert.throws(
    () => compileText(`p(X) :- q(X, Y). p(X, Y) :- q(X, Y).`),
    /arity/,
  );
  const engine = new Engine();
  engine.addRules(`p(X) :- q(X).`);
  assert.throws(() => engine.addFact("q", "a", "b"), /arity/);
});
