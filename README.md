# 输入法组合期间的采集控件回放

表单采集测试宿主调用可导入的TypeScript输入回放包，单控件事件按严格递增序号输入，含控件代数、唯一事件ID及完整字符串值。compositionStart开始临时值，update及组合中的input替换临时值，end确认临时值；非组合input立即确认。input可引用beforeInput事件ID，被取消的beforeInput令该input忽略；end后的首个input若引用该end的ID只确认一次，不再追加确认。未知关联或无组合的update/end使整批回滚。代数增加以该事件给定初值替换控件并清除组合，旧代事件忽略。返回确认值与来源ID；测试组合取消、重复末尾input及换代。

## API

默认导出和命名导出 `replayInput`，也可使用 `replay`、`replayEvents` 或 `replayInputEvents`：

```ts
import { replayInput, type ReplayEvent } from "./index.ts";

const events: ReplayEvent[] = [
  { seq: 1, generation: 1, id: "s1", type: "compositionStart", value: "" },
  { seq: 2, generation: 1, id: "u1", type: "update", value: "你" },
  { seq: 3, generation: 1, id: "e1", type: "end", value: "你" },
];

const confirmations = replayInput(events);
// [{ value: "你", sourceId: "e1" }]
```

每个事件接受 `seq`、`generation`、`id`、`type` 和 `value`。`beforeInput` 可用 `canceled: true` 标记取消；`input` 通过 `beforeInputId` 关联对应的 `beforeInput` 或 `compositionEnd`。组合取消可使用 `compositionCancel` 事件，或在 `compositionEnd` 上标记 `canceled: true`。换代时可用 `reset` 事件提供新代初值，其他事件首次出现更高 `generation` 时也会按该事件的值替换控件。

结果为确认记录数组，记录形如 `{ value, sourceId }`。数组上还提供只读的 `values`、`sourceIds`、`rolledBack`、`status`、`value` 和 `generation`。任一更新或结束事件缺少有效组合、或出现未知关联时，整批返回空数组并设置 `rolledBack: true`。

运行测试：

```sh
npm test
```
