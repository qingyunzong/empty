# merkle-consistency

针对仅追加日志（append-only log）的 Merkle 前缀一致性证明库，算法遵循 RFC 6962
（Certificate Transparency）的 Merkle 树定义。仅使用 Node.js 内置模块
（`node:crypto`、`node:test`、`node:assert`），零运行时依赖。

- 叶子哈希：`SHA-256(0x00 || data)`；内部节点：`SHA-256(0x01 || left || right)`
- 空树根：`SHA-256("")`（`e3b0c442…b855`）
- 验证器只持有：两棵树的**大小**、两个**根哈希**和**证明**，无需访问日志本体

## 空树 / 等长树规则（生成器与验证器一致）

| 条件 | 证明 | 验证规则 |
| --- | --- | --- |
| `firstSize === 0` | 空证明 | 证明必须为空，且 `firstRoot` 必须等于空树根哈希；`secondSize === 0` 时 `secondRoot` 也必须是空树根 |
| `firstSize === secondSize` | 空证明 | 证明必须为空，且两个根哈希必须相等 |
| `0 < firstSize < secondSize` | 非空证明 | 按 RFC 6962 §2.1.4.2 重建两个根并比对，证明过长/过短/节点非 32 字节均拒绝 |
| `firstSize > secondSize` | 生成器抛 `RangeError` | 验证器返回 `false` |

## 用法

```ts
import { MerkleTree, generateConsistencyProof, verifyConsistencyProof } from "./src/index";

const tree = new MerkleTree();
for (let i = 0; i < 10; i++) tree.append(`record-${i}`);

const firstRoot = tree.root(4);   // 旧树（4 片叶子）的根，验证器已持有
const secondRoot = tree.root(10); // 新树的根

const proof = generateConsistencyProof(tree, 4, 10);
const ok = verifyConsistencyProof(4, 10, firstRoot, secondRoot, proof); // true
```

`src/inclusion.ts` 另提供单叶包含证明（audit path）的生成与验证，测试用它证明：
包含证明**不能**冒充前缀一致性证明（唯一合法重叠是叶子 0 的 audit path 恰好等于
`(1, n)` 的一致性证明，这是 RFC 6962 的固有性质，其余组合全部被拒绝）。

## 测试

```sh
npm test   # tsc 编译 + node --test 运行 dist/test/*.test.js
```

测试内容：

- 哈希原语对空树/空叶子的已知向量
- 空树、等长树规则的正反用例，非法尺寸与非法节点长度（31/33 字节）拒绝
- 枚举 0–16 片叶子的全部 `(first, second)` 尺寸对（共 153 对），诚实证明全部通过
- 对每对尺寸的证明：逐节点比特翻转、置零、删除、首尾加节点、置空、相邻交换、
  两根互换/错根，全部必须拒绝
- 包含证明冒充一致性证明：枚举尺寸 2–16 × 全部 `first` × 全部叶索引，除
  `(first=1, index=0)` 的合法重叠外全部拒绝；反向（一致性证明冒充包含证明）同样拒绝

## 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

```
$ npm test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"
ok 1 - dist/test/consistency.test.js
# pass 1
# fail 0

$ node dist/test/consistency.test.js   # 展开明细
ok 1 - hash primitives
ok 2 - empty-tree and equal-tree rules
ok 3 - exhaustive valid consistency proofs (all size pairs up to 16 leaves)
ok 4 - proof-node corruption is always rejected
ok 5 - an inclusion proof cannot masquerade as a consistency proof
# tests 13
# suites 5
# pass 13
# fail 0
```
