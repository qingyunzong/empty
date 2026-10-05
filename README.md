# manifest-merge

制品清单三向合并库。输入共同祖先 `base` 与两个分支 `ours` / `theirs`，
输出合并结果、冲突列表，以及一份**可逆计划**。

纯 TypeScript + Node.js 内置库（`node:test` / `node:assert`），无第三方运行时依赖。

## 数据模型

```ts
interface ArtifactEntry {
  id: string;      // 对象 ID：跨清单稳定，是识别同一制品的唯一依据
  path: string;    // 路径：普通属性，可被任一分支修改（移动/改名）
  digest: string;  // 内容摘要：代表制品内容版本
}
```

身份由 `id` 决定，路径只是属性——因此**路径移动按对象 ID 识别**，
同一 `id` 在三侧的路径差异即移动。

## 合并规则

逐 ID 独立裁决（第一阶段），再做跨 ID 撞名检查（第二阶段）：

| 场景 | 结果 |
| --- | --- |
| 仅一侧改摘要 / 移动 | 采用改动侧 |
| 双侧改成**相同**摘要（或相同路径） | 直接合并，不算冲突 |
| 双侧改成**不同**摘要 | `digest-conflict` 冲突 |
| 双侧移到不同路径 | `move-conflict` 冲突 |
| 一侧移动 + 另一侧改摘要 | 字段各自独立合并，可叠加 |
| 移动/新增落到其他对象已占用的路径 | `path-collision` 冲突，**不自动覆盖**，涉及对象全部移出结果 |
| 仅一侧新增 | 采用新增 |
| 双侧新增同一 id 且完全一致 | 合并成功；否则 `add-add` 冲突 |
| 一侧删除 + 另一侧未改 | 接受删除 |
| 一侧删除 + 另一侧修改 | `delete-modify` 冲突 |
| 双侧都删除 | 接受删除 |

冲突条目不进入 `merged` 与 `plan`；每条冲突携带三侧快照，便于人工裁决。

## 可逆计划

`plan` 是把 `base` 变为 `merged` 的有序操作序列（`add` / `remove` / `update`），
每个操作都携带逆操作所需的全部信息：

```ts
import { mergeManifests, applyPlan, invertPlan } from "manifest-merge";

const { merged, conflicts, plan } = mergeManifests({ base, ours, theirs });
applyPlan(base, plan);                 // === merged
applyPlan(merged, invertPlan(plan));   // === base（回滚）
```

存在冲突时，计划只覆盖无冲突部分：应用到 `base` 后冲突对象保持原状，逆计划仍可完整还原。

## 运行

需要 Node.js（≥18）与 TypeScript 编译器（`tsc`）：

```sh
npm test   # tsc 编译 + node --test 运行全部测试
```

## 测试

`test/merge.test.ts` 按“小规模、独立、逐 ID 规则核对”组织：每条规则用 1～3 个
对象的最小清单独立验证，另加可逆计划与输入校验用例。

实际运行结果（Node v22.22.1，tsc 7.0.2，`npm test` 通过，退出码 0）：

```
ok 1 - 无变化：原样合并，计划为空，无冲突
ok 2 - 仅 ours 改摘要：采用 ours
ok 3 - 仅 theirs 改摘要：采用 theirs
ok 4 - 双侧改成相同摘要：直接合并，不算冲突
ok 5 - 双侧改成不同摘要：digest-conflict，不进入结果与计划
ok 6 - 路径移动按对象 ID 识别：仅 ours 移动则采用新路径
ok 7 - 双侧移到同一路径：合并成功
ok 8 - 双侧移到不同路径：move-conflict
ok 9 - 移动撞名不自动覆盖：ours 把 a 移到 b 已占用的路径
ok 10 - 一侧移动与另一侧改摘要可叠加：同 ID 不同字段各自合并
ok 11 - 仅一侧新增：采用新增
ok 12 - 双侧新增且完全一致：合并成功
ok 13 - 双侧新增同一 id 但内容不同：add-add 冲突
ok 14 - 一侧删除且另一侧未改：接受删除
ok 15 - 一侧删除但另一侧修改：delete-modify 冲突
ok 16 - 双侧都删除：接受删除
ok 17 - 计划可逆：applyPlan(base, plan) === merged，逆计划可还原 base
ok 18 - 含冲突时计划仍只覆盖无冲突部分且可逆
ok 19 - 同一清单内 id 重复：抛错
# tests 19
# pass 19
# fail 0
```
