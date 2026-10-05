# table-query-engine

TypeScript 增量表查询库：过滤 + 按键求和 + 排序取前 k，批更新后只发布新旧结果的净差，
订阅者读取其固定的版本；排序同分时按键升序。查询条件或参数的任何更改都会产生新的
查询代（generation），每一批更新都会与全扫描结果自动核对。运行时仅依赖 Node.js 内置库。

## 结构

- `src/conditions.ts` — 可序列化过滤条件（`eq/ne/lt/lte/gt/gte/in`）、规范化和代 id（sha256）。
- `src/engine.ts` — `TableQueryEngine`：行存储、增量分组求和、top-k、净差发布、版本快照、订阅。
- `test/engine.test.ts` — `node:test` 测试，含 300 批随机更新的全扫描核对。
- `types/node-shims.d.ts` — 离线环境下为 Node 内置模块提供的最小类型声明（运行时无依赖）。

## 核心语义

- **查询**：`{ where, groupBy, sum, topK }`。`where` 为 AND 条件列表；按 `groupBy` 列分键，
  对 `sum` 列求和；按和降序、同分按键升序取前 `topK`。
- **批更新**：`applyBatch([{ id, row? }, ...])` 原子应用一批 upsert/delete（省略 `row` 即删除），
  同一 id 在一批内的多次操作折叠为净效应。每代每批恰好发布一次。
- **净差**：发布内容 = 新旧 top-k 结果的差集（`added` / `removed` / `updated`，含新旧和与名次），
  未受影响的键不出现在 delta 中。
- **版本**：每代从 1 开始单调递增；`read(generation, version)` 读取任意保留版本。
- **订阅者**：`subscribe` 固定当前版本，`readSubscriber` 永远读到该固定版本，不受后续批次影响。
- **查询代**：代 id 由规范化后的查询规格哈希得到；条件或参数（含 topK）更改即产生新代，
  相同规格复用同一代及其状态。
- **核对**：`applyBatch` 末尾自动对每一代做全扫描重算并与增量状态逐键比对，不一致即抛错。

## 运行

```sh
npm test   # tsc 编译 + node --test
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 退出码 0。逐条结果（`node dist/test/engine.test.js` 的 TAP 输出）：

```
ok 1 - filter + sum-by-key + top-k with initial full scan
ok 2 - ties in sum are broken by key ascending
ok 3 - batch publishes only the net diff between old and new results
ok 4 - net diff reports added and removed keys around the top-k boundary
ok 5 - deletes shrink groups and empty groups disappear
ok 6 - row moving in and out of the filter updates sums correctly
ok 7 - subscribers read their pinned version across later batches
ok 8 - changing conditions or parameters yields a new generation
ok 9 - every batch is checked against a full scan (randomized, 300 batches)
# tests 9
# pass 9
# fail 0
# duration_ms ~250-350
```

汇总（`node --test`）：`tests 1, pass 1, fail 0`（1 个测试文件，内含上述 9 个子测试）。

## 示例

```ts
import { TableQueryEngine } from './src/index.js';

const engine = new TableQueryEngine();
engine.applyBatch([
  { id: 'r1', row: { region: 'eu', sku: 'apple', amount: 5 } },
  { id: 'r2', row: { region: 'eu', sku: 'banana', amount: 3 } },
]);

const { generation } = engine.registerQuery({
  where: [{ field: 'region', op: 'eq', value: 'eu' }],
  groupBy: 'sku',
  sum: 'amount',
  topK: 2,
});

const token = engine.subscribe(generation);        // 固定在当前版本
const [pub] = engine.applyBatch([
  { id: 'r2', row: { region: 'eu', sku: 'banana', amount: 10 } },
]);
// pub.delta = [{ key: 'banana', change: 'updated', oldSum: 3, newSum: 10, oldRank: 2, newRank: 1 }]
engine.readSubscriber(token);                       // 仍读到固定版本的旧结果
```
