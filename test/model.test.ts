import { test } from "node:test";
import assert from "node:assert";
import { lowestCommonAncestors } from "../src/lca";
import { fullReachability, modelMergeBases } from "../src/model";
import {
  issueAncestorCertificate,
  verifyAncestorCertificate,
  issueMergeBaseCertificate,
  verifyMergeBaseCertificate,
} from "../src/certificate";
import { mulberry32, randomDag, randomInt, randomQueries } from "./util/random";

test("随机小 DAG：库结果与全可达集合模型一致（多基点）", () => {
  const SEEDS = 300;
  const QUERY_ROUNDS = 8;
  let checked = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed);
    const nodeCount = randomInt(rand, 1, 14);
    const graph = randomDag(rand, nodeCount, 3);
    const ids = graph.commits();
    const reachability = fullReachability(graph);

    // 祖先集合本身也与模型一致
    for (const id of ids) {
      assert.deepEqual(
        [...graph.ancestorsOf(id)].sort(),
        [...reachability.get(id)!].sort(),
        `seed=${seed} ancestorsOf(${id})`,
      );
    }

    for (let round = 0; round < QUERY_ROUNDS; round++) {
      const queryCount = randomInt(rand, 2, 4);
      const queries = randomQueries(rand, ids, queryCount);
      const expected = modelMergeBases(graph, queries);
      const actual = lowestCommonAncestors(graph, queries);
      assert.deepEqual(
        actual,
        expected,
        `seed=${seed} queries=${queries.join(",")}`,
      );

      // 证书核对：每个基点都能给出到每个查询点的有效祖先路径
      const cert = issueMergeBaseCertificate(graph, queries);
      assert.deepEqual(
        cert.bases.map((b) => b.base),
        expected,
        `seed=${seed} cert bases`,
      );
      assert.ok(
        verifyMergeBaseCertificate(graph, cert),
        `seed=${seed} cert verify`,
      );
      for (const base of expected) {
        for (const query of queries) {
          const ancestorCert = issueAncestorCertificate(graph, base, query);
          assert.ok(ancestorCert, `seed=${seed} issue ${base}->${query}`);
          assert.ok(verifyAncestorCertificate(graph, ancestorCert!));
        }
      }
      checked++;
    }
  }
  assert.ok(checked >= SEEDS * QUERY_ROUNDS);
});

test("随机增量插入：成环必拒、无环必收", () => {
  const SEEDS = 100;
  for (let seed = 1000; seed < 1000 + SEEDS; seed++) {
    const rand = mulberry32(seed);
    const graph = randomDag(rand, randomInt(rand, 2, 12), 2);
    const ids = graph.commits();
    for (let attempt = 0; attempt < 20; attempt++) {
      const child = ids[randomInt(rand, 0, ids.length - 1)]!;
      const parent = ids[randomInt(rand, 0, ids.length - 1)]!;
      const wouldCycle =
        child === parent || graph.isAncestor(child, parent);
      const before = JSON.stringify([...graph.getParents(child)]);
      if (wouldCycle) {
        assert.throws(
          () => graph.addParents(child, [parent]),
          undefined,
          `seed=${seed} ${child}->${parent} must be rejected`,
        );
        assert.equal(JSON.stringify([...graph.getParents(child)]), before);
      } else {
        graph.addParents(child, [parent]);
      }
    }
  }
});
