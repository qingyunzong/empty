# tag-stats

按事件 ID 维护多维标签组合计数的统计库。TypeScript 实现，仅依赖 Node.js 内置模块（`node:test` / `node:assert`，仅测试使用），无第三方运行时依赖。

## 语义

- **事件即标签集合**：每个事件 ID 对应一份 `维度名 -> 字符串值` 的标签集合，库维护「全维度组合 -> 计数」的稀疏聚合（归零组合立即移除）。
- **空标签 ≠ 缺失标签**：`{env: ""}` 与 `{}` 是不同组合。组合键用「按维度名排序的 `[维度, 值]` 对」做 JSON 编码，缺失维度不出现，空值编码为 `""`，两者天然区分。
- **原子更正**：`correct(id, newTags)` 一次完成「撤旧(-1) + 加新(+1)」。全部校验（事件存在、标签合法）通过后才开始变更，撤旧与加新在同一同步区间内生效，失败不留部分状态。新旧组合相同则为无操作。
- **任意投影查询**：`query(dims)` 支持 0..4 维（`MAX_PROJECTION_DIMS`）任意维度子集聚合，0 维返回总计数；超过 4 维抛 `RangeError`，维度重复/为空抛 `TypeError`。结果按键排序，输出确定。
- **稀疏差分**：`publish` / `correct` / `retract` 返回 `DiffEntry[]`，只含计数实际变化的组合（`tags` / `before` / `after` / `delta`），净变化为 0 的条目被过滤。
- **逐条投影核对**：`verify(dims?)` 从事件存储把全部事件逐条投影重新折叠，与在线聚合结果双向比对，返回 `mismatches`；省略 `dims` 时核对全维度组合计数。

## API

```ts
import { TagStats } from "./src/stats.js";

const stats = new TagStats();
stats.publish("e1", { env: "prod", tier: "gold" });   // -> DiffEntry[]
stats.correct("e1", { env: "prod", tier: "silver" }); // 原子撤旧加新 -> 稀疏差分
stats.query(["tier"]);                                 // 1 维投影 -> ComboCount[]
stats.verify();                                        // 全事件逐条投影核对 -> VerifyResult
stats.retract("e1");                                   // 撤回 -> DiffEntry[]
```

## 测试

```sh
npm test   # tsc 编译后用 node:test 运行 dist/test/*.test.js
```

### 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
# Subtest: publish 后按全维度组合计数
ok 1 - publish 后按全维度组合计数
# Subtest: 空标签不等于缺失标签
ok 2 - 空标签不等于缺失标签
# Subtest: 投影支持 0..4 维，超过 4 维或维度重复被拒绝
ok 3 - 投影支持 0..4 维，超过 4 维或维度重复被拒绝
# Subtest: correct 撤旧加新原子发布，返回稀疏差分
ok 4 - correct 撤旧加新原子发布，返回稀疏差分
# Subtest: correct 校验失败不产生任何部分状态
ok 5 - correct 校验失败不产生任何部分状态
# Subtest: publish 重复 ID 与 retract 语义
ok 6 - publish 重复 ID 与 retract 语义
# Subtest: 查询结果与差分按键排序，输出确定
ok 7 - 查询结果与差分按键排序，输出确定
# Subtest: 随机操作序列：每次操作后 verify，并用全部事件逐条投影核对所有 <=4 维投影
ok 8 - 随机操作序列：每次操作后 verify，并用全部事件逐条投影核对所有 <=4 维投影
1..8
# tests 8
# pass 8
# fail 0
```

其中用例 8 以固定种子（mulberry32, seed=20261005）在 5 个维度 × 4 种取值（含空串与缺失）× 40 个事件 ID 的空间内随机执行 3000 次 publish/correct/retract，**每次操作后**执行 `verify()` 全量核对；结束后对全部 31 个 0..4 维子集投影，与测试内独立实现的「全部事件逐条投影」暴力参照逐一比对，并逐个执行 `verify(subset)`。

## 文件

- `src/stats.ts` — 库本体（`TagStats` 类与类型定义）
- `test/stats.test.ts` — 测试（`node:test` + `node:assert/strict`）
- `test/node-shims.d.ts` — 无网络环境下 `node:test` / `node:assert` 的极简环境类型声明
