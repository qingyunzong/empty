# anomaly-segment-detector

增量异常段检测库。点 `(id, value)` 按 `(value, id)` 排序维护；相邻点之间的边在
值差**严格超过**阈值时记为异常边；**异常段**是极大连续异常边序列，段成员为这段
边覆盖的所有点，**段 ID 取最小成员 ID**。

- 插入点：拆分其前后邻居之间的旧边为两条新边，异常段随之分裂 / 延伸 / 重新合并。
- 删除点：其两侧边被移除，邻居合并为一条新边，可能把两个异常段连成一段。
- 每次变更都增量维护段结构，`fullScan` 提供完整边扫描的参考实现用于对照。

仅使用 TypeScript + Node.js 内置库（`node:test` / `node:assert`），无运行时依赖。

## 使用

```ts
import { AnomalyDetector, fullScan } from "./src/detector.js";

const d = new AnomalyDetector(10); // 阈值 10
d.insert(1, 0);
d.insert(2, 100);   // 边 1-2 差 100 > 10 -> 异常段 [1, 2]
d.insert(3, 50);    // 拆分旧边 1-2 -> 边 1-3、3-2 均异常 -> 段 [1, 3, 2]
d.delete(3);        // 合并出新边 1-2 -> 段回到 [1, 2]

d.segments();       // [{ id: 1, members: [1, 2] }]（id = 最小成员 ID）
fullScan(d.points(), 10); // 完整边扫描，结果与增量维护一致
```

## 测试

```sh
npm test   # tsc 编译到 dist/ 后，用 node:test 运行全部测试
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2。`npm test` 实际输出（摘要）：

```
# Subtest: AnomalyDetector basics
    ok 1 - empty detector has no segments
    ok 2 - edge at or below threshold is not anomalous
    ok 3 - segment id is the minimum member id, not the first in sorted order
    ok 4 - rejects duplicate insert and unknown delete
    ok 5 - rejects invalid threshold
ok 1 - AnomalyDetector basics
# Subtest: insert splits old edge
    ok 1 - splitting an anomalous edge can keep one merged segment
    ok 2 - splitting an anomalous edge can break a segment into two
    ok 3 - insert re-merges the two halves of the segment it split
ok 2 - insert splits old edge
# Subtest: delete merges new edge
    ok 1 - deleting a middle point merges neighbours into an anomalous edge
    ok 2 - deleting a bridging point splits one segment into two
    ok 3 - deleting an endpoint shrinks or dissolves a segment
    ok 4 - delete can merge two segments through the new edge
ok 3 - delete merges new edge
# Subtest: duplicate values
    ok 1 - equal values order by id and never form anomalous edges among themselves
ok 4 - duplicate values
# Subtest: differential test against full edge scan
    ok 1 - random inserts/deletes match fullScan (threshold=0)
    ok 2 - random inserts/deletes match fullScan (threshold=1)
    ok 3 - random inserts/deletes match fullScan (threshold=7)
    ok 4 - random inserts/deletes match fullScan (threshold=25)
    ok 5 - larger scale spot-check every 50 steps
ok 5 - differential test against full edge scan
# tests 18
# suites 5
# pass 18
# fail 0
```

差分测试用固定种子的 PRNG 驱动：4 组阈值各 4000 步随机增删（每步都与
`fullScan` 全量对照），另有 20000 步规模测试每 50 步对照一次，全部一致。

## 结构

- `src/detector.ts` — `AnomalyDetector`（增量维护）与 `fullScan`（完整边扫描参考实现）
- `test/detector.test.ts` — 定向用例 + 随机差分测试
- `types/node.d.ts` — `node:test` / `node:assert` 的最小类型声明（避免外部依赖）
