# 增量外键校验状态

可导入的 TypeScript 外键状态组件。父、子变更可以乱序到达；缺失父记录先形成
pending 候选，到达截止水位后固化为最终违反，窗口封闭后的修复只追加新事件，不改写
历史。

## 快速开始

```ts
import { ForeignKeyState } from "./index.ts";

const fk = new ForeignKeyState({ window: 5 });

// 子记录先到，父记录尚未出现。
fk.applyChild({ key: "c1", parentKey: "p1", version: 1 });
// pending: c1 -> p1，截止水位为 1 + 5 = 6

fk.advanceWatermark(6);
// 窗口到期：c1 的 missing-parent 候选成为版本 6 的最终违反

fk.applyParent({ key: "p1", version: 7 });
// 父记录到达：追加 repair 事件；原违反仍在最终历史中，状态变为 resolved
```

## 语义

- **乱序更新**：变更携带单调的 `version`。低于当前记录版本的迟到变更会记为
  `stale` 并被忽略，因此迟到的父删除不会击穿更新的父插入。
- **pending**：子记录引用尚未见过的父键时，不立即失败。记录进入
  `pendingByChild`，截止水位为 `version + window`，也可用事件上的
  `deadline` / `deadlineWatermark` 显式指定。
- **可撤销候选**：截止水位前父记录到达，pending 会以
  `pending-revoked` 事件撤销，不产生违反。
- **父删除联动**：删除父记录时，所有当前引用它的子记录立即成为
  `parent-deleted` 违反；仍在 pending 中的子记录也同时固化。父删除之后才到达、
  且引用该删除父键的子记录同样立即违反。
- **窗口封闭**：`advanceWatermark(w)` 只固化 `deadline <= w` 的候选；
  `closeWindow(w?)` 固化所有剩余候选。封闭后新出现的缺失父引用立即违反。
- **不可变历史**：最终违反记录（`finalizedVersion`、`childVersion`、原因等）永不
  改写。之后的父插入只追加 `repair` 事件，在最终违反上计算
  `status: "resolved"`、`resolvedVersion` 和 `resolvedBy`。

## API

`ForeignKeyState`（别名 `ForeignKeyTracker`、`ForeignKeyValidator`、
`IncrementalForeignKeyState`）提供：

- 变更：`apply`、`applyParent`、`applyChild`、`upsertParent`、
  `deleteParent`、`upsertChild`、`deleteChild` 及 `insert*/update*/remove*`
  别名。
- 水位：`advanceWatermark` / `advance` / `advanceTo`，
  `closeWindow` / `close` / `finalize` / `finalizeWindow`。
- 查询：`getPending`、`getViolations`（默认包含已修复的历史违反）、
  `getActiveViolations`、`getViolation`、`getHistory`、`snapshot`
  以及对应的 `pending`、`violations`、`finalViolations`、
  `activeViolations`、`finalViolationVersions`、`finalViolationVersion`、
  `history` getter。
- 状态：`watermark`、`version`、`closed`、`getWatermark`、
  `getVersion`、`isClosed`。

父变更键字段支持 `key` / `id` / `parentKey` / `parentId` /
`parent_key` / `parent_id` / `pk`；子变更键字段支持 `key` / `id` /
`childKey` / `childId` / `child_key` / `child_id` / `ck`，父引用支持
`parentKey` / `parentId` / `parent_key` / `parent_id` / `parent` /
`references` / `ref` / `fk` / `foreignKey`。`version` 也接受
`at`、`ts`、`timestamp`、`eventTime`、`rowVersion`、`watermark` 别名。

构造参数：`window`（别名 `windowSize`、`grace`、`gracePeriod`、
`pendingWindow`、`delay`，默认 `0`）、`watermark`、
`initialWatermark`、`version`、`initialVersion`、`closed`。

## 测试

```sh
npm test
```

测试通过 `tsc` 转译后运行，不依赖 Node 内置 TypeScript 支持。
