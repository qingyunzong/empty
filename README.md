# doc-sync

文档同步器：以**稳定文件 ID** 为键对 `base` / `local` / `remote` 三个快照做三方合并，
解决冲突后生成**原子变更计划**，并用**逐文件三方模型**独立核对合并结果。
仅使用 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 数据模型

- `DocFile = { id, path, fields }`：文件以稳定 `id` 标识，`path` 与 `fields` 是可变内容。
- `Snapshot = { files: Record<id, DocFile> }`：某一侧（base / local / remote）的完整状态。

## 合并规则（`merge()`，src/merge.ts）

按文件 ID 对齐三份快照，逐文件三方合并：

- 仅一侧变化（含新增、删除、修改、改名）→ 采用该侧结果。
- 两侧相同变化 → 直接采用，不产生冲突。
- 两侧不同变化：
  - **字段级合并**：不同字段各自修改可自动合并；同一字段两侧改值不同 → `field` 冲突。
  - **路径**：一侧改名采用之；两侧改成不同路径 → `path` 冲突。
  - **删除对修改**：一侧删除、另一侧修改 → `delete-vs-modify` 冲突。
- **同目标路径占用**：合并后多个文件 ID 占用同一路径 → `path-occupancy` 冲突，
  按侧（local / remote）选择该组文件的路径归属。
- 存在未解决冲突时，相关文件不进入合并输出，且不生成变更计划。

## 冲突解决与过时撤销（src/resolution.ts）

- 每个冲突有稳定 `key`（如 `f1:field:title`、`f1:delete-vs-modify`、`occupancy:/shared.md`）
  和由相关 base/local/remote 输入计算的 `signature`。
- `ResolutionStore.resolve(conflict, choice)` 记录选择及其签名，可 JSON 序列化持久化。
- 再次合并时：签名一致 → 应用选择；**源版本变化导致签名不一致或冲突消失 → 撤销（revoke）
  过时选择**并在结果 `revoked` 中报告，冲突重新变为未解决。

## 原子变更计划（src/plan.ts）

- 无未解决冲突时输出 `ChangePlan { atomic: true, ops }`，把 `local` 变换为合并结果；
  操作含 `create` / `delete` / `move` / `update`（字段 set/unset）。
- `applyPlan` 校验每条操作的前置条件（文件存在、路径匹配）与后置条件（路径唯一），
  任一失败即抛错，保证计划要么整体适用要么整体拒绝。

## 逐文件三方核对（`verifyMerge()`，src/verify.ts）

独立于合并实现，按三方不变量逐文件复核：

- 未分叉文件必须与变化侧一致；分叉文件的每个字段、路径、存在性必须符合
  “仅一侧变→取该侧；两侧同变→取同值；两侧异变→必须有已应用解决且取值一致，
  否则必须存在对应未解决冲突且文件不得出现在输出中”。
- 占用冲突解决所强制的路径归属计入期望。
- 合并输出路径唯一；有冲突时不得有计划，无冲突时计划必须能把 `local` 重放出合并结果。
- 返回违规列表，空列表表示核对通过。

## 使用

```ts
import { merge, ResolutionStore, verifyMerge, applyPlan } from './src/index.js';

const store = new ResolutionStore();
const result = merge(base, local, remote, store);
for (const conflict of result.conflicts) store.resolve(conflict, 'local');
const final = merge(base, local, remote, store);
const violations = verifyMerge(base, local, remote, final); // [] 表示通过
if (final.plan) applyPlan(local, final.plan);               // 原子应用
```

## 测试

```
npm test    # tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

### 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

18 个测试全部通过：

```
ok 1 - three-way merge by stable file id        (4 tests)
ok 2 - conflicts and resolutions                (5 tests)
ok 3 - stale resolution revocation              (3 tests)
ok 4 - atomic change plan                       (3 tests)
ok 5 - per-file three-way verification          (2 tests)
ok 6 - resolution store persistence             (1 test)
# tests 18
# pass 18
# fail 0
```

覆盖：单侧增删改透传、按 ID 跨改名跟踪、不同字段自动合并、字段/路径/删除对修改/
同目标路径占用四类冲突及双侧解决、源版本变化撤销过时选择（无关字段变化不误撤）、
计划精确重放与前置条件校验、篡改合并结果与错误计划能被核对发现、解决记录 JSON 往返。
