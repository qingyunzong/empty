# doc-sync 文档同步器

基于**稳定文件 ID** 的三方（base / local / remote）文档合并器。仅使用 TypeScript + Node.js 内置库（`node:crypto`、`node:test`、`node:assert`），无第三方依赖。

## 合并模型（逐文件三方核对）

每个文件以稳定 `id` 标识（路径可改），合并按 id 对齐 base/local/remote 三侧条目：

- **字段级三方合并**：某字段仅一侧相对 base 变化则取该侧；双侧改**不同字段**自动合并；双侧改**同一字段**且值不同 → `field` 冲突（字段删除对修改也算）。
- **路径三方合并**：仅一侧改名取该侧；双侧改到**相同**路径自动合并；双侧改到**不同**路径 → `rename` 冲突。
- **删除对修改**：一侧删除、另一侧与 base 一致 → 删除；另一侧有改动 → `delete-modify` 冲突。
- **同目标路径占用**：合并后两个存活文件落到同一路径 → `path-occupation` 冲突（一侧已删除则路径释放，不冲突）。

## 冲突解决与过时撤销

- 每个冲突有稳定 `conflictId`（如 `field:a:title`、`delete-modify:a`、`paths:a+b`）和 `fingerprint`（所涉三侧条目含版本号的 SHA-256 摘要）。
- 解决方案 `Resolution` 记录做出选择时的指纹；再次合并时指纹不匹配（**源版本变化**）即被撤销，进入 `stale` 列表，冲突重新出现。
- 解决方式：字段/改名冲突可按侧选择或显式取值；删除-修改冲突选 `delete`/`keep`；路径占用冲突为涉及文件显式分配路径，分配后仍冲突则保持未解决。

## 原子变更计划

- `synchronize()` 只有在**零未解决冲突**时才产出 `ChangePlan`，否则 `plan = null`。
- 计划由 base → 合并结果的差异生成，操作顺序保证应用全程路径唯一：先 `delete`，再把所有改名文件 `move` 到临时路径，最后 `create`/`update` 落位（路径交换也能安全应用）。
- `verifyPlan()` 在 base 副本上逐步应用计划：每步校验路径唯一、临时路径必须回收、最终结果必须与合并状态逐文件一致；任一步失败即抛错，计划整体作废（原子性）。

## 运行测试

```sh
npm test   # tsc 编译后运行 node:test 测试
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 实际输出（摘要）：

```
merge.test.js:  tests 12  pass 12  fail 0
plan.test.js:   tests 5   pass 5   fail 0
合计 17 个用例全部通过
```

逐条用例：

```
ok 1  - 不同字段的修改自动合并
ok 2  - 同一字段双侧修改 -> 字段冲突，可按侧解决
ok 3  - 解决后源版本变化 -> 撤销过时选择，冲突重现
ok 4  - 一侧删除、另一侧未修改 -> 删除，无冲突
ok 5  - 删除对修改 -> delete-modify 冲突，可分别按 delete/keep 解决
ok 6  - 字段级删除对修改 -> 字段冲突
ok 7  - 双侧改名到不同路径 -> rename 冲突；改到同一路径 -> 自动合并
ok 8  - 不同文件占用同一目标路径 -> path-occupation 冲突，显式分配路径解决
ok 9  - 路径占用解决方案仍冲突 -> 冲突保持未解决
ok 10 - 一侧删除释放路径，另一侧改名占用 -> 无冲突
ok 11 - 单侧新增与双侧同内容新增 -> 无冲突
ok 12 - 双侧新增同 id 不同字段 -> 按空 base 逐字段合并/冲突
ok 13 - 存在未解决冲突时不产出计划
ok 14 - 计划应用到 base 精确复现合并结果（含增删改）
ok 15 - 交换路径：计划经临时移动保持全程路径唯一
ok 16 - 原子性：被篡改的计划在校验阶段整体失败
ok 17 - 计划与合并结果不一致时 verifyPlan 抛错
```

## 目录结构

- `src/model.ts` — 条目/快照/合并结果类型与相等性工具
- `src/merge.ts` — 逐文件三方合并、冲突检测、解决方案应用与过时撤销
- `src/plan.ts` — 原子变更计划生成、应用与校验
- `src/index.ts` — `synchronize()` 高层入口
- `test/merge.test.ts`、`test/plan.test.ts` — 逐文件三方模型与计划原子性测试
- `types/node-shims.d.ts` — 本环境无法安装 `@types/node`，为所用内置 API 提供最小声明
