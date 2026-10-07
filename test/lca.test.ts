import { test } from "node:test";
import assert from "node:assert";
import { VersionGraph } from "../src/graph";
import { commonAncestors, lowestCommonAncestors } from "../src/lca";

test("线性历史：基点是较深的共同祖先", () => {
  const graph = new VersionGraph();
  graph.addCommit("a");
  graph.addCommit("b", ["a"]);
  graph.addCommit("c", ["b"]);
  assert.deepEqual(lowestCommonAncestors(graph, ["a", "c"]), ["a"]);
  assert.deepEqual(lowestCommonAncestors(graph, ["b", "c"]), ["b"]);
  assert.deepEqual(lowestCommonAncestors(graph, ["c", "c"]), ["c"]);
});

test("菱形合并：唯一最近共同祖先", () => {
  const graph = new VersionGraph();
  graph.addCommit("a");
  graph.addCommit("b", ["a"]);
  graph.addCommit("c", ["a"]);
  graph.addCommit("m", ["b", "c"]);
  assert.deepEqual(lowestCommonAncestors(graph, ["b", "c"]), ["a"]);
  assert.deepEqual(lowestCommonAncestors(graph, ["m", "c"]), ["c"]);
  assert.deepEqual(lowestCommonAncestors(graph, ["m", "b"]), ["b"]);
});

test("十字交叉合并：多个最近共同祖先", () => {
  const graph = new VersionGraph();
  graph.addCommit("a");
  graph.addCommit("b", ["a"]);
  graph.addCommit("c", ["a"]);
  graph.addCommit("m1", ["b", "c"]);
  graph.addCommit("m2", ["c", "b"]);
  // m1 与 m2 的共同祖先为 {a, b, c}，其中 b、c 互不祖先，均为最近共同祖先
  assert.deepEqual(lowestCommonAncestors(graph, ["m1", "m2"]), ["b", "c"]);
});

test("被支配的共同祖先被剔除", () => {
  const graph = new VersionGraph();
  graph.addCommit("a");
  graph.addCommit("b", ["a"]);
  graph.addCommit("c", ["b"]);
  // 共同祖先 {a, b}，a 是 b 的真祖先，只剩 b
  assert.deepEqual(lowestCommonAncestors(graph, ["b", "c"]), ["b"]);
});

test("无共同祖先：不相连的两棵历史", () => {
  const graph = new VersionGraph();
  graph.addCommit("r1");
  graph.addCommit("r2");
  graph.addCommit("x", ["r1"]);
  graph.addCommit("y", ["r2"]);
  assert.deepEqual(lowestCommonAncestors(graph, ["x", "y"]), []);
  assert.deepEqual([...commonAncestors(graph, ["x", "y"])], []);
});

test("多个基点（3 个及以上查询）", () => {
  const graph = new VersionGraph();
  graph.addCommit("a");
  graph.addCommit("b", ["a"]);
  graph.addCommit("c", ["a"]);
  graph.addCommit("d", ["b", "c"]);
  graph.addCommit("e", ["b"]);
  // e 的祖先不含 c，三者共同祖先只剩 a
  assert.deepEqual(lowestCommonAncestors(graph, ["d", "e", "c"]), ["a"]);
  assert.deepEqual(lowestCommonAncestors(graph, ["d", "e"]), ["b"]);
  assert.deepEqual(lowestCommonAncestors(graph, ["d", "e", "b"]), ["b"]);
  assert.deepEqual(lowestCommonAncestors(graph, ["a", "b", "c", "d"]), ["a"]);
});
