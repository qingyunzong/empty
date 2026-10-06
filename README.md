# PN-Counter CRDT

基于 PN-Counter（Positive-Negative Counter）的 CRDT 计数库，TypeScript 实现，计数为任意精度 `bigint`。

## 设计

- **每副本增减分量**：每个副本的每个代际维护一对只增分量 `inc` / `dec`，键为 `replicaId#generation`。
- **合并取分量最大**：`merge` 对每个 `(副本, 代际)` 的 `inc`、`dec` 分别取最大值，满足交换律、结合律、幂等，乱序与重复合并均收敛。
- **撤回 = 新增反向量**：`undoIncrement` / `undoDecrement` 通过追加等量反向分量实现，旧分量只增不减、绝不删除。
- **重启换代际**：`restart()` 将代际 +1，旧代际分量原样保留，新代际从零累计。
- **计数值**：所有分量 `inc - dec` 之和，等价于完整操作集合的代数和（含负结果）。

## 使用

```ts
import { PNCounter } from "./src/pn-counter";

const a = new PNCounter("A");
a.increment(5n);
a.undoIncrement(5n); // 撤回：新增反向量，旧 inc=5 保留
a.restart();         // 重启：进入代际 2
a.decrement(3n);

const b = new PNCounter("B");
b.merge(a);          // 分量取最大，幂等
console.log(b.value()); // -3n
```

## 测试

```sh
npm test
```

先 `tsc` 编译到 `dist/`，再用 Node 内置测试器运行。测试覆盖：

- 基本增减与超出 `Number.MAX_SAFE_INTEGER` 的 bigint 大数；
- 撤回只加反向量、旧量保留；
- 副本重启携带新代际、旧代际分量保留；
- 合并取最大且幂等；
- 多种子随机操作（含撤回/重启）下，乱序 + 重复合并收敛到完整操作集合求和；
- 减量多于增量时收敛到负的代数和；
- 快照 JSON 序列化/反序列化保持 bigint 精度。
