"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const assert = __importStar(require("node:assert/strict"));
const tag_dag_1 = require("../src/tag-dag");
// ---------- 朴素模型：直接基于边列表计算，用于交叉核验 ----------
function modelAncestors(nodes, edges, id) {
    const parentsOf = new Map();
    for (const n of nodes)
        parentsOf.set(n, []);
    for (const [p, c] of edges)
        parentsOf.get(c).push(p);
    const result = new Set();
    const stack = [...parentsOf.get(id)];
    while (stack.length > 0) {
        const node = stack.pop();
        if (result.has(node))
            continue;
        result.add(node);
        for (const p of parentsOf.get(node))
            stack.push(p);
    }
    return result;
}
function modelLcas(nodes, edges, a, b) {
    const ancA = modelAncestors(nodes, edges, a);
    ancA.add(a);
    const ancB = modelAncestors(nodes, edges, b);
    ancB.add(b);
    const common = [...ancA].filter((x) => ancB.has(x));
    return common
        .filter((c) => !common.some((other) => other !== c && modelAncestors(nodes, edges, other).has(c)))
        .sort((x, y) => x - y);
}
/** 逐节点核验：图中每个节点的祖先集合都与朴素模型一致。 */
function assertAncestorsMatchModel(dag, nodes, edges) {
    assert.deepEqual(dag.tagIds(), [...nodes].sort((a, b) => a - b));
    assert.deepEqual(dag.edges(), [...edges].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    for (const id of nodes) {
        assert.deepEqual([...dag.ancestorsOf(id)].sort((x, y) => x - y), [...modelAncestors(nodes, edges, id)].sort((x, y) => x - y), `节点 ${id} 的严格祖先集合`);
        assert.deepEqual([...dag.ancestorsOrSelf(id)].sort((x, y) => x - y), [...modelAncestors(nodes, edges, id), id].sort((x, y) => x - y), `节点 ${id} 的祖先集合（含自身）`);
    }
}
// ---------- 逐节点祖先集合模型核验 ----------
(0, node_test_1.describe)("逐节点祖先集合模型核验", () => {
    (0, node_test_1.test)("多父节点（多祖先）与自身", () => {
        //     1   2
        //      \ / \
        //       3   4
        //      / \ /
        //     5   6
        const nodes = [1, 2, 3, 4, 5, 6];
        const edges = [
            [1, 3],
            [2, 3],
            [2, 4],
            [3, 5],
            [3, 6],
            [4, 6],
        ];
        const dag = new tag_dag_1.TagDag();
        for (const n of nodes)
            dag.addTag(n);
        for (const [p, c] of edges)
            dag.addEdge(p, c);
        assertAncestorsMatchModel(dag, nodes, edges);
        // 多祖先：6 有两个直接父节点，祖先集合含 {1,2,3,4}
        assert.deepEqual([...dag.ancestorsOf(6)].sort((x, y) => x - y), [1, 2, 3, 4]);
        // 自身：严格祖先不含自己，含自身的集合包含自己
        assert.ok(!dag.ancestorsOf(6).has(6));
        assert.ok(dag.ancestorsOrSelf(6).has(6));
        assert.deepEqual([...dag.ancestorsOrSelf(1)].sort((x, y) => x - y), [1]);
    });
    (0, node_test_1.test)("随机 DAG 全节点祖先集合核验", () => {
        let seed = 42;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        for (let round = 0; round < 20; round++) {
            const count = 5 + Math.floor(rand() * 15);
            const nodes = Array.from({ length: count }, (_, i) => (i + 1) * 7);
            const shuffled = [...nodes].sort(() => rand() - 0.5);
            const edges = [];
            for (let i = 0; i < count; i++) {
                for (let j = i + 1; j < count; j++) {
                    if (rand() < 0.25)
                        edges.push([shuffled[i], shuffled[j]]);
                }
            }
            const dag = new tag_dag_1.TagDag();
            for (const n of nodes)
                dag.addTag(n);
            for (const [p, c] of edges)
                dag.addEdge(p, c);
            assertAncestorsMatchModel(dag, nodes, edges);
        }
    });
});
// ---------- 最近公共祖先 ----------
(0, node_test_1.describe)("最近公共祖先（LCA）", () => {
    (0, node_test_1.test)("菱形 DAG：唯一最近公共祖先", () => {
        const dag = new tag_dag_1.TagDag();
        for (const n of [1, 2, 3, 4])
            dag.addTag(n);
        dag.addEdge(1, 2);
        dag.addEdge(1, 3);
        dag.addEdge(2, 4);
        dag.addEdge(3, 4);
        assert.deepEqual(dag.lowestCommonAncestors(2, 3), [1]);
        assert.deepEqual(dag.lowestCommonAncestors(4, 4), [4], "自身与自身");
        assert.deepEqual(dag.lowestCommonAncestors(1, 4), [1], "一方是另一方祖先");
        assert.deepEqual(dag.lowestCommonAncestors(2, 4), [2]);
    });
    (0, node_test_1.test)("多个最近公共祖先，结果按 ID 升序", () => {
        // 10、20 都是 30、40 的共同祖先且互不支配；5 是更高的共同祖先，应被淘汰。
        const dag = new tag_dag_1.TagDag();
        for (const n of [5, 30, 40, 10, 20])
            dag.addTag(n); // 乱序注册
        dag.addEdge(5, 10);
        dag.addEdge(5, 20);
        dag.addEdge(10, 30);
        dag.addEdge(20, 30);
        dag.addEdge(10, 40);
        dag.addEdge(20, 40);
        assert.deepEqual(dag.lowestCommonAncestors(30, 40), [10, 20]);
        assert.deepEqual(dag.lowestCommonAncestors(40, 30), [10, 20], "参数顺序无关");
    });
    (0, node_test_1.test)("无共同祖先返回空数组", () => {
        const dag = new tag_dag_1.TagDag();
        for (const n of [1, 2, 3])
            dag.addTag(n);
        dag.addEdge(1, 2);
        assert.deepEqual(dag.lowestCommonAncestors(2, 3), []);
    });
    (0, node_test_1.test)("随机 DAG 的 LCA 与朴素模型一致", () => {
        let seed = 7;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        for (let round = 0; round < 20; round++) {
            const count = 4 + Math.floor(rand() * 12);
            const nodes = Array.from({ length: count }, (_, i) => i + 1);
            const shuffled = [...nodes].sort(() => rand() - 0.5);
            const edges = [];
            for (let i = 0; i < count; i++) {
                for (let j = i + 1; j < count; j++) {
                    if (rand() < 0.3)
                        edges.push([shuffled[i], shuffled[j]]);
                }
            }
            const dag = new tag_dag_1.TagDag();
            for (const n of nodes)
                dag.addTag(n);
            for (const [p, c] of edges)
                dag.addEdge(p, c);
            for (const a of nodes) {
                for (const b of nodes) {
                    assert.deepEqual(dag.lowestCommonAncestors(a, b), modelLcas(nodes, edges, a, b), `LCA(${a}, ${b})`);
                }
            }
        }
    });
});
// ---------- 批量改边与成环拒绝 ----------
(0, node_test_1.describe)("批量改边", () => {
    function makeChain() {
        const dag = new tag_dag_1.TagDag();
        for (const n of [1, 2, 3, 4])
            dag.addTag(n);
        dag.addEdge(1, 2);
        dag.addEdge(2, 3);
        dag.addEdge(3, 4);
        return dag;
    }
    (0, node_test_1.test)("合法批次原子生效", () => {
        const dag = makeChain();
        dag.applyEdgeChanges({ add: [[1, 3]], remove: [[2, 3]] });
        assert.deepEqual(dag.edges(), [
            [1, 2],
            [1, 3],
            [3, 4],
        ]);
    });
    (0, node_test_1.test)("成环批次整体拒绝，图保持原样", () => {
        const dag = makeChain();
        const before = dag.edges();
        assert.throws(() => dag.applyEdgeChanges({ add: [[1, 3], [4, 1]] }), /会产生环 1 -> 2 -> 3 -> 4 -> 1/);
        assert.deepEqual(dag.edges(), before, "失败后图不变（含合法的那条边也未提交）");
    });
    (0, node_test_1.test)("直接自环与间接成环都被拒绝", () => {
        const dag = makeChain();
        assert.throws(() => dag.addEdge(2, 2), /不允许自环/);
        assert.throws(() => dag.addEdge(4, 2), /会产生环/);
        assert.deepEqual(dag.edges(), [
            [1, 2],
            [2, 3],
            [3, 4],
        ]);
    });
    (0, node_test_1.test)("同批先删后加：删除打破的环不算成环", () => {
        const dag = makeChain();
        // 单独加 3 -> 2 会成环（2 -> 3 -> 2），但同批删除 2 -> 3 后合法。
        dag.applyEdgeChanges({ remove: [[2, 3]], add: [[3, 2]] });
        assert.deepEqual(dag.edges(), [
            [1, 2],
            [3, 2],
            [3, 4],
        ]);
    });
    (0, node_test_1.test)("非法改动被拒绝", () => {
        const dag = makeChain();
        assert.throws(() => dag.addEdge(1, 2), /边已存在/);
        assert.throws(() => dag.removeEdge(1, 3), /待删除的边不存在/);
        assert.throws(() => dag.addEdge(1, 99), /标签不存在: 99/);
        assert.throws(() => dag.addEdge(99, 1), /标签不存在: 99/);
        assert.throws(() => dag.ancestorsOf(99), /标签不存在: 99/);
    });
});
