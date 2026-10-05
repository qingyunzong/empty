# anomaly-segment-detector

按排序事件流增量维护"相邻值差超过阈值"的异常边，并由连续异常边组成异常段的检测库。
仅使用 TypeScript + Node.js 内置模块（`node:test` / `node:assert`），无任何运行时依赖。

## 模型

- 事件点按 `(value, id)` 升序维护，相邻点之间构成一条边；
- 边的值差（右值 − 左值）**严格大于** `threshold` 时称为异常边；
- 极大连续异常边序列构成异常段，段成员为边覆盖的事件点；
- **段 ID 取成员点中最小的 id**。

## 增量维护

- `insert(id, value)`：新点把一条旧边拆成两条新边。由于新边是旧边的子区间，
  只有被拆的是异常边时段结构才会变化（段可能扩张、被切成两段或消失），
  仅对受影响点区间 `[pos-1, pos+1]` 做局部重建。
- `delete(id)`：被删点两侧的两条旧边合并为一条新边。合并边不短于任一旧边，
  因此删除可能产生异常边（生成新段、把两个段连成一段）或使段收缩，
  仅对受影响点区间 `[pos-1, pos]` 做局部重建。
- 局部重建 `rebuildAround`：移除与受影响区间相交的段，重扫该区间内的边，
  重新生成极大异常段；区间外的段不受影响。
- `fullScan()`：完整边扫描的对照实现，从当前点集重扫全部边计算段，
  用于校验增量结果（见测试）。

## API

```ts
import { AnomalyDetector } from "./src/anomaly-detector.ts";

const d = new AnomalyDetector(10); // 阈值
d.insert(99, 0);
d.insert(7, 50);
d.insert(42, 100);
d.segments();
// => [{ id: 7, memberIds: [99, 7, 42], edgeCount: 2, startValue: 0, endValue: 100 }]
d.delete(7); // 合并边 100 仍异常
d.segments();
// => [{ id: 42, memberIds: [99, 42], edgeCount: 1, startValue: 0, endValue: 100 }]
```

- `insert(id, value)`：id 重复抛错，value 必须有限；
- `delete(id): boolean`：id 不存在返回 `false`；
- `segments()`：增量维护的当前异常段；
- `fullScan()`：完整边扫描的对照结果；
- `snapshot()` / `size` / `has(id)`：点集快照与查询。

## 运行

```sh
npm test        # tsc 编译到 dist/ 后用 node --test 运行
npm run typecheck
```

要求：Node.js >= 18（`node:test`），TypeScript 编译器（本仓库用全局 `tsc` 7.0.2 验证）。
源码使用 `.ts` 扩展名相对导入，由 `rewriteRelativeImportExtensions` 在编译时改写为 `.js`。

## 实际测试结果

环境：Node.js v22.22.1，tsc 7.0.2，2026-10-06 实跑。

`npm run typecheck`：通过，无错误。

`npm test`（TAP 输出摘要，13/13 通过）：

```
ok 1 - 空检测器与单点都没有异常段
ok 2 - 阈值边界：差值必须严格大于阈值
ok 3 - 段 ID 取成员中的最小 id，与插入顺序无关
ok 4 - 插入点拆分旧边：两条新边都不异常时段消失
ok 5 - 插入点拆分旧边：一个段被切成两个段
ok 6 - 插入点拆分旧边：新点并入剩余段
ok 7 - 删除点合并新边：产生新的异常段
ok 8 - 删除点合并新边：两个段连成一段
ok 9 - 删除点使段收缩直至消失
ok 10 - 相同值按 id 排序，差值为 0 不构成异常边
ok 11 - 非法输入：重复 id、非法阈值、删除不存在的 id
ok 12 - 随机插入/删除与完整边扫描逐步对照
ok 13 - 段的不变量：极大、有序、段 ID 为最小成员 id
# tests 13
# pass 13
# fail 0
```

其中测试 12 用确定性 PRNG（mulberry32）在 4 组种子/阈值组合下共 6000 步随机
插入/删除，每一步都将增量维护的 `segments()` 与完整边扫描 `fullScan()` 做
`deepEqual` 对照，全部一致。
