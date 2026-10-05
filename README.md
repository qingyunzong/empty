# merkle-consistency

校验追加日志（append-only log）两棵 Merkle 树的前缀一致性证明库。
算法遵循 RFC 6962（Certificate Transparency）的 Merkle 树定义，
仅使用 Node.js 内置库（`node:crypto`、`node:test`），零运行时依赖。

## 模型

- 日志只能追加叶子；第 `i` 片叶子的哈希为 `SHA-256(0x00 || leaf)`，
  内部节点为 `SHA-256(0x01 || left || right)`。
- 证明方持有全部叶子，生成一致性证明 `PROOF(m, n)`。
- **验证器只持有两个 `(size, root)` 摘要和证明本身**，
  不接触任何叶子数据：
  `verifyConsistency(oldSize, oldRoot, newSize, newRoot, proof)`。

## 空树 / 等长规则（明确约定）

| 条件 | 判定 |
| --- | --- |
| `oldSize > newSize` | 一律拒绝 |
| `oldSize === newSize` | 仅当证明为空且两根摘要相等时接受 |
| `oldSize === 0 < newSize` | 仅当证明为空时接受（空树是任何树的前缀） |
| `0 < oldSize < newSize` | 按 RFC 6962 §2.1.2 算法验证，证明必须非空 |

空树（大小 0）的根定义为 `SHA-256("")`（RFC 6962 §2.1）。

注意（RFC 6962 语义）：密码学绑定作用在两棵树的**根**上。`size` 参数
驱动验证器的 fn/sn 下标运算，同一组「证明 + 根」在少数相邻 size 标签下
也能通过下标检查；但错误的 size 标签永远不可能对应一棵真实存在的、
根相同的树（需要哈希第二原像），因此不削弱只追加性质的验证。

## 用法

```ts
import { AppendOnlyLog, verifyConsistency } from "./src/merkle.js";

const log = new AppendOnlyLog();
log.append(Buffer.from("event-0"));
log.append(Buffer.from("event-1"));
const oldSize = log.size;
const oldRoot = log.root();

log.append(Buffer.from("event-2"));
const proof = log.consistencyProof(oldSize);

// 验证器只需要：
const ok = verifyConsistency(oldSize, oldRoot, log.size, log.root(), proof);
```

## 测试

```
npm test
```

`pretest` 会用全局 `tsc` 把 TypeScript 编译到 `dist/` 再运行
（本机 Node 构建未启用原生类型剥离；`types/node.d.ts` 提供所用
内置 API 的最小声明，无需安装任何 npm 包）。

覆盖内容（叶子数枚举至 16）：

- 空树与等长的全部边界规则（上表逐条断言）；
- 全部 `0 <= m <= n <= 16` 共 153 组 (m, n) 的生成-验证往返；
- 每个证明节点逐位损坏、逐节点删除、追加节点、交换节点、
  错误根摘要 —— 全部必须拒绝；
- 每个证明对其余所有真实 `(size, root)` 对（153 组）必须拒绝，
  仅对自身参数接受；
- 畸形输入（节点/根长度错误、负数、非整数 size）必须拒绝；
- 包含证明（inclusion proof）逐叶子枚举，**不能冒充前缀一致性证明**：
  仅当其与真正的一致性证明逐字节相同时才可能被接受；
- 包含证明自身的往返与篡改拒绝。

## 实际测试结果

在本机（Node.js v22.22.1）执行 `npm test` 的实际输出：

```
ok 1 - empty-tree and equal-size rules are explicit
ok 2 - all pairs 0 <= m <= n <= 16 verify with the generated proof
ok 3 - every corrupted proof node is rejected
ok 4 - a proof verifies only against its own genuine (size, root) pair
ok 5 - malformed inputs are rejected
ok 6 - an inclusion proof cannot masquerade as a consistency proof
ok 7 - inclusion proofs verify and reject tampering
# tests 7
# pass 7
# fail 0
```
