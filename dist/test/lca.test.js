"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = __importDefault(require("node:assert"));
const graph_1 = require("../src/graph");
const lca_1 = require("../src/lca");
(0, node_test_1.test)("线性历史：基点是较深的共同祖先", () => {
    const graph = new graph_1.VersionGraph();
    graph.addCommit("a");
    graph.addCommit("b", ["a"]);
    graph.addCommit("c", ["b"]);
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["a", "c"]), ["a"]);
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["b", "c"]), ["b"]);
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["c", "c"]), ["c"]);
});
(0, node_test_1.test)("菱形合并：唯一最近共同祖先", () => {
    const graph = new graph_1.VersionGraph();
    graph.addCommit("a");
    graph.addCommit("b", ["a"]);
    graph.addCommit("c", ["a"]);
    graph.addCommit("m", ["b", "c"]);
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["b", "c"]), ["a"]);
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["m", "c"]), ["c"]);
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["m", "b"]), ["b"]);
});
(0, node_test_1.test)("十字交叉合并：多个最近共同祖先", () => {
    const graph = new graph_1.VersionGraph();
    graph.addCommit("a");
    graph.addCommit("b", ["a"]);
    graph.addCommit("c", ["a"]);
    graph.addCommit("m1", ["b", "c"]);
    graph.addCommit("m2", ["c", "b"]);
    // m1 与 m2 的共同祖先为 {a, b, c}，其中 b、c 互不祖先，均为最近共同祖先
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["m1", "m2"]), ["b", "c"]);
});
(0, node_test_1.test)("被支配的共同祖先被剔除", () => {
    const graph = new graph_1.VersionGraph();
    graph.addCommit("a");
    graph.addCommit("b", ["a"]);
    graph.addCommit("c", ["b"]);
    // 共同祖先 {a, b}，a 是 b 的真祖先，只剩 b
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["b", "c"]), ["b"]);
});
(0, node_test_1.test)("无共同祖先：不相连的两棵历史", () => {
    const graph = new graph_1.VersionGraph();
    graph.addCommit("r1");
    graph.addCommit("r2");
    graph.addCommit("x", ["r1"]);
    graph.addCommit("y", ["r2"]);
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["x", "y"]), []);
    node_assert_1.default.deepEqual([...(0, lca_1.commonAncestors)(graph, ["x", "y"])], []);
});
(0, node_test_1.test)("多个基点（3 个及以上查询）", () => {
    const graph = new graph_1.VersionGraph();
    graph.addCommit("a");
    graph.addCommit("b", ["a"]);
    graph.addCommit("c", ["a"]);
    graph.addCommit("d", ["b", "c"]);
    graph.addCommit("e", ["b"]);
    // e 的祖先不含 c，三者共同祖先只剩 a
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["d", "e", "c"]), ["a"]);
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["d", "e"]), ["b"]);
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["d", "e", "b"]), ["b"]);
    node_assert_1.default.deepEqual((0, lca_1.lowestCommonAncestors)(graph, ["a", "b", "c", "d"]), ["a"]);
});
