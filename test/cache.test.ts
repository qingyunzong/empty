import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { ConflictCache } from "../src/cache.js";

const universe = (constraints: string[], assumptions: string[]) => ({
  constraints: new Set(constraints),
  assumptions: new Set(assumptions),
});

test("add normalizes order and rejects duplicates", () => {
  const cache = new ConflictCache();
  ok(cache.add({ constraints: ["c2", "c1"], assumptions: ["h1"], note: "n" }));
  ok(!cache.add({ constraints: ["c1", "c2"], assumptions: ["h1"], note: "n" }));
  equal(cache.all().length, 1);
  deepEqual(cache.all()[0]?.constraints, ["c1", "c2"]);
});

test("a conflict is reusable only while every source still exists", () => {
  const cache = new ConflictCache();
  cache.add({ constraints: ["c1"], assumptions: ["h1"], note: "needs h1" });
  cache.add({ constraints: ["c2", "c3"], assumptions: [], note: "pure constraints" });

  // Everything present: both reusable.
  equal(cache.valid(universe(["c1", "c2", "c3"], ["h1"])).length, 2);
  // Assumption h1 retracted: only the pure-constraint conflict survives.
  const after = cache.valid(universe(["c1", "c2", "c3"], []));
  equal(after.length, 1);
  deepEqual(after[0]?.constraints, ["c2", "c3"]);
  // Constraint c3 deleted as well: nothing is reusable.
  equal(cache.valid(universe(["c1", "c2"], [])).length, 0);
});

test("findApplicable requires the conflict sources to be active", () => {
  const cache = new ConflictCache();
  cache.add({ constraints: ["c1"], assumptions: ["h1"], note: "n" });
  // Superset of the conflict's sources is active -> applicable.
  ok(cache.findApplicable(universe(["c1", "c2"], ["h1", "h2"])) !== undefined);
  // h1 not active -> not applicable.
  equal(cache.findApplicable(universe(["c1", "c2"], ["h2"])), undefined);
  // c1 not active -> not applicable.
  equal(cache.findApplicable(universe(["c2"], ["h1"])), undefined);
});

test("re-adding a retracted assumption makes the old conflict reusable again", () => {
  const cache = new ConflictCache();
  cache.add({ constraints: ["k1"], assumptions: ["h1"], note: "n" });
  equal(cache.findApplicable(universe(["k1"], [])), undefined);
  ok(cache.findApplicable(universe(["k1"], ["h1"])) !== undefined);
});
