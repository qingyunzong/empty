import { test } from "node:test";
import * as assert from "node:assert";
import { buildGraph } from "../src/graph.js";
import { deterministicOrder, enumerateOrders } from "../src/topo.js";
import { LogEvent } from "../src/types.js";
import { mulberry32, randomDag } from "./util.js";

const ev = (id: string, ts: number, deps: string[] = [], source = "s", seq = 0): LogEvent => ({
  id,
  source,
  seq,
  ts,
  deps,
});

test("each round picks the ready candidate with smallest (ts, source, seq, id)", () => {
  const g = buildGraph([
    ev("b", 5, [], "beta", 0),
    ev("a", 5, [], "alpha", 0),
    ev("c", 5, [], "alpha", 1),
    ev("d", 3),
  ]);
  const res = deterministicOrder(g);
  assert.deepStrictEqual(res.order, ["d", "a", "c", "b"]);
  assert.deepStrictEqual(res.candidates, ["d", "a", "c", "b"]);
});

test("timestamps need not be causally monotonic: causality still wins", () => {
  const g = buildGraph([ev("parent", 100), ev("child", 1, ["parent"])]);
  const res = deterministicOrder(g);
  assert.deepStrictEqual(res.order, ["parent", "child"]);
});

test("missing dependencies withhold events and are reported with evidence", () => {
  const g = buildGraph([ev("a", 1, ["x"]), ev("b", 2, ["a"]), ev("c", 3)]);
  const res = deterministicOrder(g);
  assert.deepStrictEqual(res.order, ["c"]);
  assert.deepStrictEqual(res.diagnostics.missing, { x: ["a"] });
  assert.deepStrictEqual(res.diagnostics.withheld, { a: ["x"], b: ["x"] });
  assert.deepStrictEqual(res.diagnostics.cycles, []);
});

test("cycles are excluded from the order and reported as concrete evidence", () => {
  const g = buildGraph([ev("a", 1, ["c"]), ev("b", 2, ["a"]), ev("c", 3, ["b"]), ev("d", 4)]);
  const res = deterministicOrder(g);
  assert.deepStrictEqual(res.order, ["d"]);
  assert.strictEqual(res.diagnostics.cycles.length, 1);
  const cyc = res.diagnostics.cycles[0];
  assert.deepStrictEqual([...cyc].sort(), ["a", "b", "c"]);
  // Verify the evidence: every event depends on the next, last on first.
  for (let i = 0; i < cyc.length; i++) {
    const next = cyc[(i + 1) % cyc.length];
    assert.ok(
      g.events.get(cyc[i])!.deps.includes(next),
      `${cyc[i]} must depend on ${next}`
    );
  }
});

test("self-dependency is reported as a length-1 cycle", () => {
  const g = buildGraph([ev("a", 1, ["a"]), ev("b", 2)]);
  const res = deterministicOrder(g);
  assert.deepStrictEqual(res.order, ["b"]);
  assert.deepStrictEqual(res.diagnostics.cycles, [["a"]]);
});

test("small graphs: greedy order equals lexicographic minimum of all enumerated orders", () => {
  const rnd = mulberry32(20261006);
  for (let t = 0; t < 300; t++) {
    const n = 1 + Math.floor(rnd() * 8);
    const events = randomDag(rnd, n, 0.4);
    const g = buildGraph(events);
    const res = deterministicOrder(g);
    const en = enumerateOrders(g);
    assert.ok(!en.truncated, `trial ${t}: enumeration truncated`);
    assert.ok(en.count >= 1);
    assert.deepStrictEqual(res.order, en.best, `trial ${t}: greedy != lex-min`);
    if (n <= 6) {
      assert.ok(
        en.orders.some((o) => JSON.stringify(o) === JSON.stringify(res.order)),
        `trial ${t}: greedy order is not a valid topological order`
      );
    }
  }
});

test("enumeration counts match brute-force expectation on a known graph", () => {
  // a -> c, b -> c: linear extensions are permutations of a,b before c = 2.
  const g = buildGraph([ev("a", 1), ev("b", 2), ev("c", 3, ["a", "b"])]);
  const en = enumerateOrders(g);
  assert.strictEqual(en.count, 2);
  assert.deepStrictEqual(en.best, ["a", "b", "c"]);
});
