# event-stats

按事件 ID 维护多维标签组合计数的统计库。TypeScript 编写，运行时仅依赖 Node.js 内置模块（`node:test` / `node:assert` 用于测试）。

## 设计

- **按事件 ID 计数**：每个事件 ID 对应一份多维标签（`Record<string, string>`），库维护「完整标签组合 → 事件数」的计数。
- **原子更正**：`correct(eventId, labels)` = 撤旧 + 加新。所有修改在写时复制的私有副本上完成，最后通过单次引用替换发布新 `Snapshot`；持旧快照的读者永远看到一致状态，不存在中间态。`labels` 传 `null` 表示删除事件；新旧标签相同则为空操作，不发布新版本。
- **空标签 ≠ 缺失标签**：`""` 是合法标签值，单独成格；缺失维度在投影单元中编码为 `null`，二者严格区分。
- **任意投影查询**：`snapshot.project(dims)` 支持 0..4 维任意子集（自动去重、排序规范化），按去重后的标签组合聚合并做记忆化缓存。
- **稀疏差分**：`diffProjections(before, after, dims)` 只输出计数发生变化的单元（含 `before`/`after`/`delta`），未变化单元缺席。
- **逐条核对**：`snapshot.verify(dims)` 用全部事件逐条投影暴力重算，与索引结果对比，返回不一致列表（空数组 = 通过）。

## API 摘要

```ts
const store = new EventStatsStore();
store.correct("e1", { region: "cn", env: "prod" });   // 新增/更正
store.correct("e1", { region: "us", env: "prod" });   // 撤旧加新，原子发布
store.correct("e2", null);                            // 删除

const snap = store.getSnapshot();
snap.project(["region", "env"]);                      // Map<单元键, 计数>
snap.verify(["region"]);                              // [] = 核对通过
diffProjections(before, after, ["region"]);           // 稀疏差分
```

投影单元键用 `decodeCell(key)` 解码为取值数组（缺失维度为 `null`，空标签为 `""`）。

## 运行测试

```sh
npm test   # = tsc -p tsconfig.json && node --test dist/test/*.test.js
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（`tsc` 编译为 JS 后由 `node --test` 运行）。
以下为 `npm test` 的真实输出（2026-10-06 运行）：

```text
ok 1 - 空标签不等于缺失标签
ok 2 - 更正 = 撤旧加新，原子发布，旧快照不受污染
ok 3 - 最多 4 维任意投影，并与逐条暴力投影核对（确定性数据集）
ok 4 - 稀疏差分只包含变化的单元
ok 5 - 随机化压力：每步更正后全部 <=4 维投影逐条核对
ok 6 - 输入校验
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1639.273058
```

测试覆盖：

1. **空标签 ≠ 缺失标签**：`""`、缺失、`"prod"` 三格互不合并，组合键亦不同。
2. **原子发布**：旧快照在更正后保持旧值；新快照撤旧加新；同事件重复更正不重复计数；空操作不发布新版本。
3. **任意投影**：5 维数据集（含缺失/空标签）叠加更正后，全部 C(5,1..4)=30 种投影与逐条暴力投影一致。
4. **稀疏差分**：仅 3 个变化单元出现，未变化单元缺席；差分应用到旧投影可还原新投影。
5. **随机化压力**：固定种子 PRNG，400 步随机更正（6 维、随机缺失/空标签），每步抽查、每 40 步全量核对 C(6,1..4)=56 种投影，终态全量核对。
6. **输入校验**：非字符串标签值、空事件 ID、空维度名、超过 4 维投影均抛错；重复维度自动去重。
