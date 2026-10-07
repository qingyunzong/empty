import { test } from "node:test";
import assert from "node:assert";
import {
  VersionGraph,
  DuplicateCommitError,
  UnknownCommitError,
  CycleError,
} from "../src/graph";

function chain(...ids: string[]): VersionGraph {
  const graph = new VersionGraph();
  ids.forEach((id, i) => graph.addCommit(id, i === 0 ? [] : [ids[i - 1]!]));
  return graph;
}

test("addCommit 记录父/子关系", () => {
  const graph = new VersionGraph();
  graph.addCommit("a");
  graph.addCommit("b", ["a"]);
  graph.addCommit("c", ["a"]);
  graph.addCommit("d", ["b", "c"]);
  assert.deepEqual(graph.getParents("d"), ["b", "c"]);
  assert.deepEqual(graph.getChildren("a"), ["b", "c"]);
  assert.equal(graph.size, 4);
});

test("addCommit 拒绝重复 id 与未知父提交", () => {
  const graph = chain("a", "b");
  assert.throws(() => graph.addCommit("a"), DuplicateCommitError);
  assert.throws(() => graph.addCommit("c", ["zzz"]), UnknownCommitError);
});

test("增量插入拒绝自环", () => {
  const graph = chain("a", "b");
  assert.throws(() => graph.addParents("a", ["a"]), CycleError);
});

test("增量插入拒绝环：直接回边与跨层回边", () => {
  const graph = chain("a", "b", "c", "d");
  assert.throws(() => graph.addParents("a", ["b"]), CycleError);
  assert.throws(() => graph.addParents("a", ["d"]), CycleError);
  assert.throws(() => graph.addParents("b", ["d"]), CycleError);
  // 拒绝后图保持原状（原子性）
  assert.deepEqual(graph.getParents("a"), []);
});

test("增量插入接受无环冗余边", () => {
  const graph = chain("a", "b", "c");
  assert.doesNotThrow(() => graph.addParents("c", ["a"]));
  assert.deepEqual([...graph.getParents("c")].sort(), ["a", "b"]);
});

test("菱形结构上回边成环被拒", () => {
  const graph = new VersionGraph();
  graph.addCommit("a");
  graph.addCommit("b", ["a"]);
  graph.addCommit("c", ["a"]);
  graph.addCommit("m", ["b", "c"]);
  assert.throws(() => graph.addParents("a", ["m"]), CycleError);
  assert.throws(() => graph.addParents("b", ["m"]), CycleError);
});

test("祖先/后代集合（含自身）", () => {
  const graph = chain("a", "b", "c");
  assert.deepEqual([...graph.ancestorsOf("c")].sort(), ["a", "b", "c"]);
  assert.deepEqual([...graph.descendantsOf("a")].sort(), ["a", "b", "c"]);
  assert.ok(graph.isAncestor("a", "c"));
  assert.ok(graph.isAncestor("b", "b"));
  assert.ok(!graph.isAncestor("c", "a"));
});
