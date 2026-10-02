# shopfloor-planner

注塑车间夜班重排工具：在未来 8 小时 horizons 上，按事件时间吸收订单、保养与撤单事件，
在模具、保养与交期约束下输出可执行序列。Node.js 22，仅标准库，单机离线。

## 用法

```sh
node bin/plan.js run --in <dir> --out <dir>
node --test   # 运行全部测试
```

`--in` 目录下所有 `*.jsonl`（按文件名排序拼接）逐行解析；`--out` 目录写出：

- `schedule.json` — 最终最优序列（并列最优全部输出，按 job 字典序）
- `corrections.json` — 迟到但可撤回数据对已产出窗口的增量更正
- `late.log` — 超过水位线且不可撤回的事件（JSONL）
- `error.json` — 输入非法时写出 `{code,msg}` 并以非零码退出

## 输入事件（JSONL）

```json
{"type":"order","arriveTs":0,"eventTs":0,"job":"J1","mold":"M1","due":28800000,"qty":30,"op":"add"}
{"type":"maint","eventTs":0,"machine":"L1","start":0,"end":7200000,"op":"add"}
{"type":"retract","eventTs":60000,"kind":"order","id":"J1"}
```

时间戳为 epoch 毫秒。`maint` 缺省 id 为 `machine:start:end`，可用显式 `id` 覆盖。

## 语义

- **水位线**：按文件顺序处理事件，水位线 = 已见最大事件时间 − 2 分钟。
- **窗口与更正**：8 小时 horizon 划分为 8 个 1 小时窗口；水位线越过窗口末尾即产出该窗口
  （内容为当前首选序列中落入窗口的作业）。迟到但可撤回的数据（order/maint 的 add）
  会被应用并对已产出窗口生成增量更正；迟到的 retract 不可撤回，进 `late.log`。
- **区间联结**：作业占用块（换模 + 加工）与保养窗口做事件时间区间联结，重叠则整块后移。
- **撤回**：retract 从状态中移除订单/保养，重算序列 —— 模具时段随之释放，被挤掉的候选恢复。
- **目标**：字典序最小化（交期违约数, 完工时间, 能耗）；≤8 作业全枚举，否则按交期贪心。
  全部并列最优序列都输出，按 job 字典序排列。
- **常量**：换模 10 分钟/5 kWh，加工 1 分钟/0.1 kWh 每件（见 `src/constants.js`）。

## 错误码

`PARSE_ERROR` `MISSING_FIELD` `INVALID_FIELD` `INVALID_OP` `INVALID_QTY` `INVALID_INTERVAL`
`INVALID_KIND` `UNKNOWN_TYPE` `DUE_INVALID`（due 早于 eventTs）`INPUT_NOT_FOUND`。
