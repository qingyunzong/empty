import { test } from "node:test";
import assert from "node:assert";
import { VersionGraph } from "../src/graph";
import {
  issueAncestorCertificate,
  verifyAncestorCertificate,
  issueMergeBaseCertificate,
  verifyMergeBaseCertificate,
} from "../src/certificate";

function crissCross(): VersionGraph {
  const graph = new VersionGraph();
  graph.addCommit("a");
  graph.addCommit("b", ["a"]);
  graph.addCommit("c", ["a"]);
  graph.addCommit("m1", ["b", "c"]);
  graph.addCommit("m2", ["c", "b"]);
  return graph;
}

test("祖先证书：签发与验证往返", () => {
  const graph = crissCross();
  const cert = issueAncestorCertificate(graph, "a", "m1");
  assert.ok(cert);
  assert.equal(cert!.ancestor, "a");
  assert.equal(cert!.descendant, "m1");
  assert.ok(verifyAncestorCertificate(graph, cert!));
  // 自反：自身到自身
  const selfCert = issueAncestorCertificate(graph, "b", "b");
  assert.ok(selfCert);
  assert.deepEqual(selfCert!.path, ["b"]);
  assert.ok(verifyAncestorCertificate(graph, selfCert!));
});

test("非祖先关系无法签发证书", () => {
  const graph = crissCross();
  assert.equal(issueAncestorCertificate(graph, "m1", "a"), null);
  assert.equal(issueAncestorCertificate(graph, "b", "c"), null);
});

test("篡改的证书被拒绝", () => {
  const graph = crissCross();
  const cert = issueAncestorCertificate(graph, "a", "m1")!;
  // 断边：路径中间插入不相邻节点
  assert.ok(
    !verifyAncestorCertificate(graph, { ...cert, path: ["a", "m1", "b"] }),
  );
  // 端点不符
  assert.ok(
    !verifyAncestorCertificate(graph, { ...cert, descendant: "m2" }),
  );
  // 不存在的节点
  assert.ok(
    !verifyAncestorCertificate(graph, { ...cert, path: ["a", "ghost", "m1"] }),
  );
  // 空路径
  assert.ok(!verifyAncestorCertificate(graph, { ...cert, path: [] }));
});

test("合并基点证书：覆盖全部基点与查询点", () => {
  const graph = crissCross();
  const cert = issueMergeBaseCertificate(graph, ["m1", "m2"]);
  assert.deepEqual(
    cert.bases.map((b) => b.base),
    ["b", "c"],
  );
  assert.ok(verifyMergeBaseCertificate(graph, cert));
  // 篡改其中一条路径即失败
  const tampered = {
    ...cert,
    bases: cert.bases.map((b, i) =>
      i === 0 ? { ...b, paths: { ...b.paths, m1: ["b", "a", "m1"] } } : b,
    ),
  };
  assert.ok(!verifyMergeBaseCertificate(graph, tampered));
});
