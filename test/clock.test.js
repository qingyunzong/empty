import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeClocks, tick, compareClocks, causalKeyCompare, lamport } from "../src/clock.js";

test("vector clock comparison", () => {
  assert.equal(compareClocks({ A: 1 }, { A: 2 }), -1);
  assert.equal(compareClocks({ A: 2 }, { A: 1 }), 1);
  assert.equal(compareClocks({ A: 1 }, { A: 1 }), 0);
  assert.equal(compareClocks({ A: 1 }, { B: 1 }), 2); // concurrent
  assert.equal(compareClocks({ A: 1, B: 1 }, { A: 1 }), 1);
  assert.equal(compareClocks({ A: 2, B: 1 }, { A: 1, B: 2 }), 2);
});

test("merge and tick", () => {
  assert.deepEqual(mergeClocks({ A: 2, B: 1 }, { B: 3, C: 1 }), { A: 2, B: 3, C: 1 });
  assert.deepEqual(tick({ A: 2 }, "A"), { A: 3 });
  assert.deepEqual(tick({}, "N"), { N: 1 });
});

test("causal key extends happens-before", () => {
  const a = { id: "op1", node: "A", clock: { A: 1 } };
  const b = { id: "op2", node: "B", clock: { A: 1, B: 1 } };
  assert.ok(compareClocks(a.clock, b.clock) === -1);
  assert.ok(causalKeyCompare(a, b) < 0); // causally earlier sorts first
  // concurrent: deterministic tiebreak by (lamport, node, id)
  const c = { id: "op3", node: "A", clock: { A: 1 } };
  const d = { id: "op4", node: "B", clock: { B: 1 } };
  assert.equal(compareClocks(c.clock, d.clock), 2);
  assert.ok(causalKeyCompare(c, d) < 0);
  assert.ok(causalKeyCompare(d, c) > 0);
  assert.equal(lamport({ A: 2, B: 3 }), 5);
});
