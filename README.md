# shift-planner

注塑车间夜班重排器：Node.js 22、仅标准库、`node:test`、单机离线。

## 模型与假设

- 事件流 JSONL，三类事件：
  - `order`：`{type, arriveTs, eventTs, job, mold, due, qty, op}`，`op` 为单件加工分钟数，加工时长 = `qty * op`。
  - `maint`：`{type, eventTs, machine, start, end, op?}`，保养窗口 `[start, end)`；隐式 id 为 `machine:start-end`，也可显式给 `id`。
  - `retract`：`{type, eventTs, kind, id}`，`kind` 为 `order`/`maint`。
- 时间字段接受 epoch 毫秒或 ISO-8601 字符串，内部统一为毫秒。
- 单条产线：所有订单在同一线上排序；换模固定 30 分钟（`changeoverMin` 可配），能耗 = 换模次数（含首件装模）。
- 换模窗口与保养窗口做事件时间区间联结：换模与加工均不可与保养窗口重叠，冲突时整体后移（不可抢占）。
- 优化目标按字典序：`(逾期作业数, 最大完工时间, 能耗)`。作业数 ≤ 9 时精确枚举全部排列，否则退化为 EDD 启发式。
- 完工时间与能耗相同的全部最优序列并列输出，按 job 字典序排序（输出上限 500 条，超出时 `truncated: true` 并给出 `totalOptimal`）。
- 水位线 = 已见最大事件时间 − 2 分钟。`eventTs < 水位线` 的事件为迟到：
  - 可撤回（合法 order/maint/retract）→ 应用并重算，向 `corrections.json` 追加一条增量更正（含 `changedJobs`）。
  - 不可撤回（如指向未知 id 的 retract）→ 记入 `late.log`，不改计划。
- 计划起点 `t0` = 已见最大事件时间；`horizonEnd = t0 + 8h`。

## 使用

```sh
node bin/plan.js run --in <dir> --out <dir>
```

- 输入：`--in` 目录下全部 `*.jsonl`，按文件名排序后逐行处理（行序即到达序）。
- 输出：`schedule.json`（全部并列最优序列）、`corrections.json`、`late.log`。
- 错误：非零退出并写 `error.json` `{code, msg}`。错误码：`PARSE_ERROR`、`SCHEMA_INVALID`、`DUE_INVALID`（due 早于 eventTs）、`WINDOW_INVALID`、`IO_ERROR`。

## 测试

```sh
node --test
```
