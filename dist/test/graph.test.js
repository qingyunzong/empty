"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = __importDefault(require("node:assert"));
const graph_1 = require("../src/graph");
function chain(...ids) {
    const graph = new graph_1.VersionGraph();
    ids.forEach((id, i) => graph.addCommit(id, i === 0 ? [] : [ids[i - 1]]));
    return graph;
}
(0, node_test_1.test)("addCommit 记录父/子关系", () => {
    const graph = new graph_1.VersionGraph();
    graph.addCommit("a");
    graph.addCommit("b", ["a"]);
    graph.addCommit("c", ["a"]);
    graph.addCommit("d", ["b", "c"]);
    node_assert_1.default.deepEqual(graph.getParents("d"), ["b", "c"]);
    node_assert_1.default.deepEqual(graph.getChildren("a"), ["b", "c"]);
    node_assert_1.default.equal(graph.size, 4);
});
(0, node_test_1.test)("addCommit 拒绝重复 id 与未知父提交", () => {
    const graph = chain("a", "b");
    node_assert_1.default.throws(() => graph.addCommit("a"), graph_1.DuplicateCommitError);
    node_assert_1.default.throws(() => graph.addCommit("c", ["zzz"]), graph_1.UnknownCommitError);
});
(0, node_test_1.test)("增量插入拒绝自环", () => {
    const graph = chain("a", "b");
    node_assert_1.default.throws(() => graph.addParents("a", ["a"]), graph_1.CycleError);
});
(0, node_test_1.test)("增量插入拒绝环：直接回边与跨层回边", () => {
    const graph = chain("a", "b", "c", "d");
    node_assert_1.default.throws(() => graph.addParents("a", ["b"]), graph_1.CycleError);
    node_assert_1.default.throws(() => graph.addParents("a", ["d"]), graph_1.CycleError);
    node_assert_1.default.throws(() => graph.addParents("b", ["d"]), graph_1.CycleError);
    // 拒绝后图保持原状（原子性）
    node_assert_1.default.deepEqual(graph.getParents("a"), []);
});
(0, node_test_1.test)("增量插入接受无环冗余边", () => {
    const graph = chain("a", "b", "c");
    node_assert_1.default.doesNotThrow(() => graph.addParents("c", ["a"]));
    node_assert_1.default.deepEqual([...graph.getParents("c")].sort(), ["a", "b"]);
});
(0, node_test_1.test)("菱形结构上回边成环被拒", () => {
    const graph = new graph_1.VersionGraph();
    graph.addCommit("a");
    graph.addCommit("b", ["a"]);
    graph.addCommit("c", ["a"]);
    graph.addCommit("m", ["b", "c"]);
    node_assert_1.default.throws(() => graph.addParents("a", ["m"]), graph_1.CycleError);
    node_assert_1.default.throws(() => graph.addParents("b", ["m"]), graph_1.CycleError);
});
(0, node_test_1.test)("祖先/后代集合（含自身）", () => {
    const graph = chain("a", "b", "c");
    node_assert_1.default.deepEqual([...graph.ancestorsOf("c")].sort(), ["a", "b", "c"]);
    node_assert_1.default.deepEqual([...graph.descendantsOf("a")].sort(), ["a", "b", "c"]);
    node_assert_1.default.ok(graph.isAncestor("a", "c"));
    node_assert_1.default.ok(graph.isAncestor("b", "b"));
    node_assert_1.default.ok(!graph.isAncestor("c", "a"));
});
