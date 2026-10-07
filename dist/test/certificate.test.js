"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = __importDefault(require("node:assert"));
const graph_1 = require("../src/graph");
const certificate_1 = require("../src/certificate");
function crissCross() {
    const graph = new graph_1.VersionGraph();
    graph.addCommit("a");
    graph.addCommit("b", ["a"]);
    graph.addCommit("c", ["a"]);
    graph.addCommit("m1", ["b", "c"]);
    graph.addCommit("m2", ["c", "b"]);
    return graph;
}
(0, node_test_1.test)("祖先证书：签发与验证往返", () => {
    const graph = crissCross();
    const cert = (0, certificate_1.issueAncestorCertificate)(graph, "a", "m1");
    node_assert_1.default.ok(cert);
    node_assert_1.default.equal(cert.ancestor, "a");
    node_assert_1.default.equal(cert.descendant, "m1");
    node_assert_1.default.ok((0, certificate_1.verifyAncestorCertificate)(graph, cert));
    // 自反：自身到自身
    const selfCert = (0, certificate_1.issueAncestorCertificate)(graph, "b", "b");
    node_assert_1.default.ok(selfCert);
    node_assert_1.default.deepEqual(selfCert.path, ["b"]);
    node_assert_1.default.ok((0, certificate_1.verifyAncestorCertificate)(graph, selfCert));
});
(0, node_test_1.test)("非祖先关系无法签发证书", () => {
    const graph = crissCross();
    node_assert_1.default.equal((0, certificate_1.issueAncestorCertificate)(graph, "m1", "a"), null);
    node_assert_1.default.equal((0, certificate_1.issueAncestorCertificate)(graph, "b", "c"), null);
});
(0, node_test_1.test)("篡改的证书被拒绝", () => {
    const graph = crissCross();
    const cert = (0, certificate_1.issueAncestorCertificate)(graph, "a", "m1");
    // 断边：路径中间插入不相邻节点
    node_assert_1.default.ok(!(0, certificate_1.verifyAncestorCertificate)(graph, { ...cert, path: ["a", "m1", "b"] }));
    // 端点不符
    node_assert_1.default.ok(!(0, certificate_1.verifyAncestorCertificate)(graph, { ...cert, descendant: "m2" }));
    // 不存在的节点
    node_assert_1.default.ok(!(0, certificate_1.verifyAncestorCertificate)(graph, { ...cert, path: ["a", "ghost", "m1"] }));
    // 空路径
    node_assert_1.default.ok(!(0, certificate_1.verifyAncestorCertificate)(graph, { ...cert, path: [] }));
});
(0, node_test_1.test)("合并基点证书：覆盖全部基点与查询点", () => {
    const graph = crissCross();
    const cert = (0, certificate_1.issueMergeBaseCertificate)(graph, ["m1", "m2"]);
    node_assert_1.default.deepEqual(cert.bases.map((b) => b.base), ["b", "c"]);
    node_assert_1.default.ok((0, certificate_1.verifyMergeBaseCertificate)(graph, cert));
    // 篡改其中一条路径即失败
    const tampered = {
        ...cert,
        bases: cert.bases.map((b, i) => i === 0 ? { ...b, paths: { ...b.paths, m1: ["b", "a", "m1"] } } : b),
    };
    node_assert_1.default.ok(!(0, certificate_1.verifyMergeBaseCertificate)(graph, tampered));
});
