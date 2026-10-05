# manifest-merge

制品清单（artifact manifest）三路合并库。输入两个分支与共同祖先，按对象 ID
识别路径移动，输出自动合并结果、冲突清单与可逆计划。仅使用 TypeScript 与
Node.js 内置库（`node:test` / `node:assert`），无第三方运行时依赖。

## 数据模型

```ts
interface Artifact { id: string; path: string; digest: string; }
type Manifest = ReadonlyArray<Artifact>; // id 在单份清单内唯一，重复即报错
```

身份是对象 `id`：祖先与分支之间 `path` 变化被识别为同一对象的移动，
而不是删除加新增。

## 逐 ID 合并规则（相互独立）

对祖先 / ours / theirs 三份清单中同一 `id` 的三个版本（可缺省）：

| 情形 | 结果 |
| --- | --- |
| 双侧删除 | 结果中移除，计划记录 `remove`（含原条目） |
| 单侧删除、另一侧未改 | 删除生效 |
| 单侧删除、另一侧修改 | `delete-modify` 冲突 |
| 单侧新增 | 采用新增方，计划记录 `add` |
| 双侧新增且一致 | 采用一份 |
| 双侧新增不一致 | `add-add` 冲突 |
| 三侧一致 / 仅一侧变更 | 采用变更方（`move` 或 `update`） |
| 双侧改为相同内容 | 合并为一份 |
| 双侧改为不同摘要 | `digest` 冲突（不自动选择） |
| 双侧同摘要但移动到不同路径 | `move-move` 冲突 |

路径撞名（移动撞名不自动覆盖）：逐 ID 合并后，若两个不同 `id` 落到同一
`path`，记为 `path-collision` 冲突，相关条目从自动合并结果与计划中剔除，
绝不静默覆盖。

## 输出

```ts
interface MergeResult {
  merged: Artifact[];    // 自动合并结果（按 id 排序，冲突 id 除外）
  conflicts: Conflict[]; // delete-modify | add-add | digest | move-move | path-collision
  plan: PlanOp[];        // 可逆计划：ancestor -> merged
}
```

计划算子：`add` / `remove`（含原条目）/ `move`（from→to 路径）/
`update`（from→to 条目）。每个算子自带逆运算所需全部信息：

- `invertPlan(plan)` 生成逆计划；`applyPlan(manifest, plan)` 应用计划；
  `revertPlan(manifest, plan)` 撤销。
- 性质：`applyPlan(ancestor, plan) === merged`，
  `revertPlan(merged, plan)` 还原 `ancestor`（测试已核对）。
- 冲突条目不进计划，需人工解决后另行应用。

## 使用

```ts
import { mergeManifests, applyPlan, revertPlan } from "manifest-merge";

const { merged, conflicts, plan } = mergeManifests(ancestor, ours, theirs);
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

测试为小规模独立用例：每个用例只构造 1–3 个制品，核对单条逐 ID 规则；
另有计划可逆性与混合场景用例。

### 实际运行结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test` 通过（退出码 0）。逐文件明细：

- `dist/test/merge.test.js`：17 个用例，17 通过，0 失败
  （删除/新增/移动/摘要/撞名各规则 + 重复 id 拒绝 + 混合场景）
- `dist/test/plan.test.js`：6 个用例，6 通过，0 失败
  （计划应用得 merged、撤销还原 ancestor、逆算子对合、逆计划倒序、
  缺失 id 与重复 add 报错）

合计 23 个用例全部通过。已额外验证：`node --test` 对失败用例返回非零
退出码，失败不会被静默吞掉。
