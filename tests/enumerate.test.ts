/**
 * Exhaustive small-tree verification: enumerate every base tree up to k
 * nodes, every legal move (sequence) on each side, merge every pair, and
 * check the result is always an acyclic, complete, well-formed tree whose
 * cycle-break evidence is consistent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findCycle,
  isSelfOrAncestor,
  makeTree,
  type NodeId,
  type Tree,
} from "../src/tree.js";
import {
  compareEdgePriority,
  del,
  mergeTrees,
  move,
  type MergeResult,
  type MoveOp,
  type TreeOp,
} from "../src/merge.js";

const ROOT = "r";

function nodeIds(k: number): NodeId[] {
  return Array.from({ length: k }, (_, i) => `n${i}`);
}

/** All valid trees with ROOT plus k labelled nodes. */
function enumerateTrees(k: number): Tree[] {
  const nodes = nodeIds(k);
  const choices = (id: NodeId) => [ROOT, ...nodes.filter((n) => n !== id)];
  const trees: Tree[] = [];
  const assign = new Map<NodeId, NodeId>();
  const walk = (i: number) => {
    if (i === nodes.length) {
      try {
        trees.push(makeTree(ROOT, [...assign.entries()].map(([c, p]) => [c, p] as const)));
      } catch {
        // cyclic or disconnected assignment: not a tree
      }
      return;
    }
    const id = nodes[i]!;
    for (const p of choices(id)) {
      assign.set(id, p);
      walk(i + 1);
    }
    assign.delete(id);
  };
  walk(0);
  return trees;
}

/** Every legal single move of `tree`, as an op factory parameterised by id/priority. */
function legalMoves(tree: Tree): Array<{ nodeId: NodeId; newParentId: NodeId }> {
  const out: Array<{ nodeId: NodeId; newParentId: NodeId }> = [];
  for (const [id, p] of tree.parent) {
    if (id === tree.rootId) continue;
    for (const target of tree.parent.keys()) {
      if (target === id || target === p) continue;
      if (isSelfOrAncestor(tree, id, target)) continue;
      out.push({ nodeId: id, newParentId: target });
    }
  }
  return out;
}

function withMove(tree: Tree, nodeId: NodeId, newParentId: NodeId): Tree {
  const parent = new Map(tree.parent);
  parent.set(nodeId, newParentId);
  return { rootId: tree.rootId, parent };
}

/** All legal move sequences of length 1..maxLen on `tree`. */
function legalMoveSequences(tree: Tree, maxLen: number): MoveOp[][] {
  const out: MoveOp[][] = [];
  const walk = (tree: Tree, prefix: MoveOp[], depth: number) => {
    if (depth === maxLen) return;
    for (const m of legalMoves(tree)) {
      const op = move(`s${prefix.length}`, 0, m.nodeId, m.newParentId);
      const seq = [...prefix, op];
      out.push(seq);
      walk(withMove(tree, m.nodeId, m.newParentId), seq, depth + 1);
    }
  };
  walk(tree, [], 0);
  return out;
}

const stats = { merges: 0, cyclesBroken: 0, tombstoned: 0 };

function assertMergeSound(base: Tree, leftOps: TreeOp[], rightOps: TreeOp[]): MergeResult {
  const result = mergeTrees(base, leftOps, rightOps);
  stats.merges += 1;
  stats.cyclesBroken += result.cycleBreaks.length;
  if (result.tombstones.size > 0) stats.tombstoned += 1;

  // 1. The merged parent map is always acyclic.
  assert.equal(findCycle(result.tree.parent), null,
    `cycle survived: base=${describe(base)} left=${JSON.stringify(leftOps)} right=${JSON.stringify(rightOps)}`);

  // 2. Exactly the base node set survives; root stays parentless.
  assert.deepEqual([...result.tree.parent.keys()].sort(), [...base.parent.keys()].sort());
  assert.equal(result.tree.parent.get(base.rootId), null);

  // 3. Every node is attached and reaches the root.
  for (const id of result.tree.parent.keys()) {
    if (id === base.rootId) continue;
    const p = result.tree.parent.get(id);
    assert.ok(p !== null && p !== undefined && result.tree.parent.has(p), `${id} detached`);
    let cur: NodeId | null = id;
    const seen = new Set<NodeId>();
    while (cur !== null && cur !== base.rootId) {
      assert.ok(!seen.has(cur), `unreachable via ${id}`);
      seen.add(cur);
      cur = result.tree.parent.get(cur) ?? null;
    }
    assert.equal(cur, base.rootId, `${id} does not reach root`);
  }

  // 4. Cycle-break evidence is consistent with the outcome.
  for (const ev of result.cycleBreaks) {
    assert.equal(ev.candidates.length, ev.cycle.length);
    const opEdges = ev.candidates.filter((c) => c.opId !== null);
    assert.ok(opEdges.length > 0, "cycle without any op edge");
    const min = opEdges.reduce((a, b) => (compareEdgePriority(a, b) <= 0 ? a : b));
    assert.equal(ev.cancelled.opId, min.opId, "cancelled edge is not the minimum");
    assert.equal(ev.cancelled.nodeId, min.nodeId);
    const own = ev.candidates.find((c) => c.nodeId === ev.cancelled.nodeId);
    assert.equal(own?.parentId, ev.cancelled.fromParentId);
    // The fallback is now the node's parent in the final tree.
    assert.equal(result.tree.parent.get(ev.cancelled.nodeId), ev.revertedTo.parentId);
    if (ev.revertedTo.source === "base") {
      assert.equal(ev.revertedTo.parentId, base.parent.get(ev.cancelled.nodeId) ?? null);
    }
    // The cancelled op edge is demoted: it can never be cancelled again.
    const later = result.cycleBreaks.indexOf(ev);
    for (const other of result.cycleBreaks.slice(later + 1)) {
      assert.notEqual(other.cancelled.opId, ev.cancelled.opId, "same op cancelled twice");
    }
  }

  // 5. Tombstones reference real nodes that are still present.
  for (const id of result.tombstones) {
    assert.ok(result.tree.parent.has(id), `tombstoned node ${id} was dropped`);
  }
  return result;
}

function describe(tree: Tree): string {
  return [...tree.parent.entries()].map(([c, p]) => `${c}->${p ?? "null"}`).join(",");
}

test("exhaustive: all 4-node base trees x all legal single moves per side x priority orders", () => {
  const bases = enumerateTrees(4);
  assert.equal(bases.length, 125); // Cayley: (4+1)^(4-1) rooted labelled trees
  const priorityPairs: Array<[number, number]> = [[1, 1], [1, 2], [2, 1]];
  for (const base of bases) {
    const moves = legalMoves(base);
    for (const lm of moves) {
      for (const rm of moves) {
        for (const [lp, rp] of priorityPairs) {
          assertMergeSound(
            base,
            [move("L1", lp, lm.nodeId, lm.newParentId)],
            [move("R1", rp, rm.nodeId, rm.newParentId)],
          );
        }
      }
    }
  }
});

test("exhaustive: all 3-node base trees x legal move sequences (up to 2) per side", () => {
  const bases = enumerateTrees(3);
  assert.equal(bases.length, 16);
  const priorityPairs: Array<[number, number]> = [[1, 1], [2, 1]];
  for (const base of bases) {
    const sequences = legalMoveSequences(base, 2);
    for (const ls of sequences) {
      for (const rs of sequences) {
        for (const [lp, rp] of priorityPairs) {
          const leftOps = ls.map((op, i) => move(`L${i}`, lp, op.nodeId, op.newParentId));
          const rightOps = rs.map((op, i) => move(`R${i}`, rp, op.nodeId, op.newParentId));
          assertMergeSound(base, leftOps, rightOps);
        }
      }
    }
  }
});

test("exhaustive: deletes x concurrent moves keep the tree sound and tombstones preserved", () => {
  const bases = enumerateTrees(3);
  for (const base of bases) {
    const deletable = [...base.parent.keys()].filter((id) => id !== base.rootId);
    const moves = legalMoves(base);
    for (const d of deletable) {
      for (const rm of moves) {
        const result = assertMergeSound(
          base,
          [del("LD", 1, d)],
          [move("R1", 1, rm.nodeId, rm.newParentId)],
        );
        assert.ok(result.tombstones.has(d), `deleted root ${d} not tombstoned`);
        assert.ok(result.tree.parent.has(d), `deleted root ${d} dropped from tree`);
      }
    }
  }
});

test("enumeration actually exercised cycle-breaking", () => {
  // Guard against the enumeration silently shrinking to trivial cases.
  assert.ok(stats.merges > 20_000, `too few merges: ${stats.merges}`);
  assert.ok(stats.cyclesBroken > 500, `too few broken cycles: ${stats.cyclesBroken}`);
  assert.ok(stats.tombstoned > 0);
  console.log(
    `enumeration totals: merges=${stats.merges} cyclesBroken=${stats.cyclesBroken} ` +
    `mergesWithTombstones=${stats.tombstoned}`,
  );
});
