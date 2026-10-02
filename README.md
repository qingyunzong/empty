# dispatch

封装厂离线派工：在机台窗口产能硬预算内，把载具派到测试机；计量（metrology）结果可晚到并回写优先级，撤回事件触发级联重排。Node.js 22，仅标准库，单机离线。

## 使用

```sh
node bin/dispatch.js solve --in <dir|file.jsonl> --out <dir>
# 或链接后： dispatch solve --in dir --out dir
```

`--in` 为目录时按文件名序合并全部 `*.jsonl`。输出到 `--out`：

- `plan.json` — 最终派工方案：`objective`、canonical `assignments`、`unassigned`、`tieCount` 及全部并列最优解 `solutions`（`tiesTruncated` 标记枚举截断）。
- `budget.json` — 每个机台窗口的 `cap / used / remaining`（remaining 恒 ≥ 0）及总量。
- `rework.jsonl` — 重排审计流：`late_event`、`replan`、`migration`、`tool_retract`、`budget_release`、`metro_pending(_resolved)`。
- `late.log` — 迟到事件（eventTs < 水位线）文本日志。

## 输入事件（JSONL，按字段推断类型）

```json
{"eventTs":"...","carrier":"C1","lot":"L1","qty":5,"op":"add","due":"...（可选）"}
{"eventTs":"...","tool":"T1","cap":10,"windowStart":"...","windowEnd":"...","op":"add"}
{"eventTs":"...","lot":"L1","score":7,"op":"add"}
{"eventTs":"...","kind":"tool","id":"T1"}                 // retract
```

- 时间戳支持 epoch 毫秒或 ISO 字符串；水位线 = 最大事件时间 − 5 分钟，eventTs 早于水位线即迟到（仍生效并触发重排）。
- `op` ∈ `add|upsert`（默认 add）/ `del|remove`；`retract` 的 `kind` ∈ `carrier|tool|metro`。
- `cap < 0` → `CAP_INVALID`（exit 2）；未知 lot 的 metro 进入 pending，不失败，对应载具到达后自动生效。

## 语义

- 区间联结：载具到达时间落在机台 `[windowStart, windowEnd]` 内才可派入；每载具最多派一个窗口，原子占用 `qty`。
- 硬预算：窗口已用 qty 总和 ≤ cap；任何事件后全量重解，始终回到当前状态的可证最优（分支定界精确求解），超分自然回滚。
- 目标：最大化 Σ score(lot) × qty。并列最优全部枚举输出；canonical 解先最小化占用数量（撤回计量即释放锁定预算），再按 (due, lot, carrier) 字典序。
- 撤回 tool 窗口：其上载具级联迁移，迁移明细记入 `rework.jsonl`，预算剩余不为负。

## 测试

```sh
node --test
```
