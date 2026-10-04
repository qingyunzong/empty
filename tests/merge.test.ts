import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTree, findCycle, type Tree } from "../src/tree.js";
import { mergeTrees, move, del, compareEdgePriority } from "../src/merge.js";

function parentsOf(tree: Tree): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [id, p] of [...tree.parent.entries()].sort()) out[id] = p;
  return out;
}

test("cross-side legal moves combine into a cycle; lowest-priority edge is cancelled with evidence", () => {
  // base: r <- a <- c, r <- b
  const base = makeTree("r", [["a", "r"], ["b", "r"], ["c", "a"]]);
  const left = [move("L1", 1, "a", "b")];  // legal: a under b
  const right = [move("R1", 2, "b", "c")]; // legal: b under c
  const result = mergeTrees(base, left, right);

  assert.equal(findCycle(result.tree.parent), null);
  assert.deepEqual(parentsOf(result.tree), { a: "r", b: "c", c: "a", r: null });

  assert.equal(result.cycleBreaks.length, 1);
  const ev = result.cycleBreaks[0]!;
  assert.deepEqual([...ev.cycle].sort(), ["a", "b", "c"]);
  assert.equal(ev.cancelled.opId, "L1"); // priority 1 < 2
  assert.equal(ev.cancelled.nodeId, "a");
  assert.equal(ev.cancelled.fromParentId, "b");
  assert.equal(ev.cancelled.side, "left");
  assert.equal(ev.revertedTo.parentId, "r");
  assert.equal(ev.revertedTo.source, "base");
  // candidates cover every cycle edge, including the untouched base edge c -> a
  assert.equal(ev.candidates.length, 3);
  const baseEdge = ev.candidates.find((c) => c.nodeId === "c");
  assert.equal(baseEdge?.opId, null);
  assert.equal(baseEdge?.parentId, "a");
  assert.ok(ev.reason.includes("L1"));
});

test("equal priorities are tie-broken by opId", () => {
  const base = makeTree("r", [["a", "r"], ["b", "r"], ["c", "a"]]);
  const left = [move("B2", 1, "a", "b")];
  const right = [move("A1", 1, "b", "c")];
  const result = mergeTrees(base, left, right);
  assert.equal(result.cycleBreaks.length, 1);
  // "A1" < "B2": right's edge loses despite left being listed first
  assert.equal(result.cycleBreaks[0]!.cancelled.opId, "A1");
  assert.equal(result.cycleBreaks[0]!.cancelled.nodeId, "b");
  assert.equal(result.tree.parent.get("b"), "r"); // reverted to base parent
  assert.equal(result.tree.parent.get("a"), "b"); // left's move survives
});

test("a cycle containing a base edge never cancels the base edge, however high op priorities are", () => {
  // base: r <- a <- c, r <- b; the merged cycle a -> b -> c -> a contains
  // the untouched base edge c -> a.
  const base = makeTree("r", [["a", "r"], ["b", "r"], ["c", "a"]]);
  const left = [move("L1", 99, "a", "b")];
  const right = [move("R1", 100, "b", "c")];
  const result = mergeTrees(base, left, right);
  assert.equal(result.cycleBreaks.length, 1);
  const ev = result.cycleBreaks[0]!;
  assert.equal(ev.cancelled.opId, "L1"); // lowest priority among op edges
  assert.equal(result.tree.parent.get("a"), "r");
  assert.equal(result.tree.parent.get("c"), "a"); // base edge untouched
  assert.equal(findCycle(result.tree.parent), null);
});

test("moving a node under its own descendant is rejected, so one side alone can never cycle", () => {
  const base = makeTree("r", [["a", "r"], ["b", "a"]]);
  const result = mergeTrees(base, [move("L1", 1, "a", "b")], []);
  assert.equal(result.rejected.left.length, 1);
  assert.match(result.rejected.left[0]!.reason, /subtree/);
  assert.equal(result.cycleBreaks.length, 0);
  assert.deepEqual(parentsOf(result.tree), { a: "r", b: "a", r: null });
});

test("both sides moving the same node: right wins; cancelling the winner falls back to left's value", () => {
  const base = makeTree("r", [["x", "r"], ["y", "r"], ["z", "r"]]);
  const left = [move("L1", 1, "x", "y"), move("L2", 5, "z", "x")];
  const right = [move("R1", 0, "x", "z")]; // wins x, but forms x -> z -> x
  const result = mergeTrees(base, left, right);

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]!.nodeId, "x");
  assert.equal(result.conflicts[0]!.winner, "right");

  assert.equal(result.cycleBreaks.length, 1);
  const ev = result.cycleBreaks[0]!;
  assert.equal(ev.cancelled.opId, "R1"); // priority 0 is the lowest in the cycle
  assert.equal(ev.revertedTo.source, "left"); // falls back to the losing side's value
  assert.equal(ev.revertedTo.parentId, "y");
  assert.equal(ev.revertedTo.opId, "L1");
  assert.equal(findCycle(result.tree.parent), null);
  assert.deepEqual(parentsOf(result.tree), { r: null, x: "y", y: "r", z: "x" });
});

test("tombstoned subtrees are preserved in the merged tree", () => {
  // base chain r <- a <- b <- c
  const base = makeTree("r", [["a", "r"], ["b", "a"], ["c", "b"]]);
  const left = [del("D1", 1, "b")];        // tombstones b and c
  const right = [move("R1", 1, "c", "r")]; // concurrent move out of the tombstoned subtree
  const result = mergeTrees(base, left, right);

  assert.deepEqual([...result.tombstones].sort(), ["b", "c"]);
  // nothing is dropped: every base node is still present and attached
  assert.deepEqual(parentsOf(result.tree), { a: "r", b: "a", c: "r", r: null });
  assert.equal(findCycle(result.tree.parent), null);
});

test("tombstones from both sides are unioned", () => {
  const base = makeTree("r", [["a", "r"], ["b", "r"], ["c", "a"], ["d", "b"]]);
  const result = mergeTrees(base, [del("LD", 1, "a")], [del("RD", 1, "b")]);
  assert.deepEqual([...result.tombstones].sort(), ["a", "b", "c", "d"]);
  assert.equal(result.tree.parent.size, 5);
});

test("illegal ops are rejected per side with reasons and do not affect the merge", () => {
  const base = makeTree("r", [["a", "r"], ["b", "a"]]);
  const left = [
    move("L1", 1, "a", "b"),      // b is inside a's subtree
    move("L2", 1, "r", "a"),      // cannot move the root
    move("L3", 1, "a", "ghost"),  // unknown parent
  ];
  const right = [del("R1", 1, "r"), del("R2", 1, "ghost")];
  const result = mergeTrees(base, left, right);

  assert.equal(result.rejected.left.length, 3);
  assert.equal(result.rejected.right.length, 2);
  assert.match(result.rejected.left[0]!.reason, /subtree/);
  assert.match(result.rejected.left[1]!.reason, /root/);
  assert.match(result.rejected.right[0]!.reason, /root/);
  assert.deepEqual(parentsOf(result.tree), { a: "r", b: "a", r: null });
  assert.equal(result.tombstones.size, 0);
});

test("sequential moves on one side apply in order; the last one wins the node", () => {
  const base = makeTree("r", [["a", "r"], ["b", "r"], ["c", "r"]]);
  const left = [move("L1", 1, "a", "b"), move("L2", 2, "a", "c")];
  const result = mergeTrees(base, left, []);
  assert.equal(result.tree.parent.get("a"), "c");
  assert.equal(result.cycleBreaks.length, 0);
});

test("compareEdgePriority orders by priority then opId, base edges last", () => {
  const edge = (opId: string | null, priority: number | null) => ({
    nodeId: "n", parentId: "p", opId, priority, side: null,
  });
  const sorted = [
    edge("B1", 1),
    edge(null, null),
    edge("A2", 1),
    edge("A1", 2),
  ].sort(compareEdgePriority);
  assert.deepEqual(sorted.map((e) => e.opId), ["A2", "B1", "A1", null]);
});

test("merge is deterministic", () => {
  const base = makeTree("r", [["a", "r"], ["b", "r"], ["c", "a"], ["d", "b"]]);
  const left = [move("L1", 3, "a", "d"), del("L2", 1, "b")];
  const right = [move("R1", 3, "b", "c"), move("R2", 1, "d", "a")];
  const first = mergeTrees(base, left, right);
  const second = mergeTrees(base, left, right);
  assert.deepEqual(parentsOf(first.tree), parentsOf(second.tree));
  assert.deepEqual(first.cycleBreaks, second.cycleBreaks);
});
