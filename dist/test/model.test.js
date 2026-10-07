"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = __importDefault(require("node:assert"));
const lca_1 = require("../src/lca");
const model_1 = require("../src/model");
const certificate_1 = require("../src/certificate");
const random_1 = require("./util/random");
(0, node_test_1.test)("随机小 DAG：库结果与全可达集合模型一致（多基点）", () => {
    const SEEDS = 300;
    const QUERY_ROUNDS = 8;
    let checked = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
        const rand = (0, random_1.mulberry32)(seed);
        const nodeCount = (0, random_1.randomInt)(rand, 1, 14);
        const graph = (0, random_1.randomDag)(rand, nodeCount, 3);
        const ids = graph.commits();
        const reachability = (0, model_1.fullReachability)(graph);
        // 祖先集合本身也与模型一致
        for (const id of ids) {
            node_assert_1.default.deepEqual([...graph.ancestorsOf(id)].sort(), [...reachability.get(id)].sort(), `seed=${seed} ancestorsOf(${id})`);
        }
        for (let round = 0; round < QUERY_ROUNDS; round++) {
            const queryCount = (0, random_1.randomInt)(rand, 2, 4);
            const queries = (0, random_1.randomQueries)(rand, ids, queryCount);
            const expected = (0, model_1.modelMergeBases)(graph, queries);
            const actual = (0, lca_1.lowestCommonAncestors)(graph, queries);
            node_assert_1.default.deepEqual(actual, expected, `seed=${seed} queries=${queries.join(",")}`);
            // 证书核对：每个基点都能给出到每个查询点的有效祖先路径
            const cert = (0, certificate_1.issueMergeBaseCertificate)(graph, queries);
            node_assert_1.default.deepEqual(cert.bases.map((b) => b.base), expected, `seed=${seed} cert bases`);
            node_assert_1.default.ok((0, certificate_1.verifyMergeBaseCertificate)(graph, cert), `seed=${seed} cert verify`);
            for (const base of expected) {
                for (const query of queries) {
                    const ancestorCert = (0, certificate_1.issueAncestorCertificate)(graph, base, query);
                    node_assert_1.default.ok(ancestorCert, `seed=${seed} issue ${base}->${query}`);
                    node_assert_1.default.ok((0, certificate_1.verifyAncestorCertificate)(graph, ancestorCert));
                }
            }
            checked++;
        }
    }
    node_assert_1.default.ok(checked >= SEEDS * QUERY_ROUNDS);
});
(0, node_test_1.test)("随机增量插入：成环必拒、无环必收", () => {
    const SEEDS = 100;
    for (let seed = 1000; seed < 1000 + SEEDS; seed++) {
        const rand = (0, random_1.mulberry32)(seed);
        const graph = (0, random_1.randomDag)(rand, (0, random_1.randomInt)(rand, 2, 12), 2);
        const ids = graph.commits();
        for (let attempt = 0; attempt < 20; attempt++) {
            const child = ids[(0, random_1.randomInt)(rand, 0, ids.length - 1)];
            const parent = ids[(0, random_1.randomInt)(rand, 0, ids.length - 1)];
            const wouldCycle = child === parent || graph.isAncestor(child, parent);
            const before = JSON.stringify([...graph.getParents(child)]);
            if (wouldCycle) {
                node_assert_1.default.throws(() => graph.addParents(child, [parent]), undefined, `seed=${seed} ${child}->${parent} must be rejected`);
                node_assert_1.default.equal(JSON.stringify([...graph.getParents(child)]), before);
            }
            else {
                graph.addParents(child, [parent]);
            }
        }
    }
});
