# demand-audit

15 分钟需量峰值复核工具：在估计电表读数被撤回、费率被撤回之后，仍能增量更正窗口电量、
重算成本，并证明切负荷决策最优。Node.js 22，仅标准库，单机离线。

## 使用

```sh
node bin/demand.js audit --in <事件目录> --out <输出目录>
# 或 npm test 运行全部测试
```

输入目录下所有 `*.jsonl` 文件按文件名排序后逐行解析（每行一个 JSON 事件）。
输出四个文件：

- `windows.jsonl` — 每个 15 分钟窗口一行：电量、毛需量、费率、已切负荷、净需量、计费
- `settlement.json` — 结算汇总：峰值、基线成本、最优切法、已执行切法、穷举校验
- `comp.jsonl` — 补偿/更正日志（电表更正、费率撤回、切负荷补偿）
- `late.log` — 迟到事件（事件时间 < 水位线 = 最大事件时间 - 1 分钟），仍被应用

## 事件模型

```jsonl
{"type":"meter","eventTs":"...","meter":"M1","kwh":123.4,"estimated":true,"op":"upsert"}
{"type":"tariff","eventTs":"...","name":"peak","start":"...","end":"...","rate":0.8,"op":"upsert"}
{"type":"shed","eventTs":"...","load":"HVAC","kw":20,"op":"upsert"}
{"type":"retract","eventTs":"...","kind":"meter|tariff|shed","id":"..."}
```

- `eventTs` 为 ISO 字符串或毫秒数；窗口 = 15 分钟对齐。
- 电表为累积量：相邻读数差分归入"较迟读数所关闭的窗口"（边界读数关闭其结束的窗口）。
- `meter` 撤回 id 为 `<表名>@<读数时间>`；同 `(meter, eventTs)` 的 upsert 视为就地更正。
- `tariff` 撤回 id 为费率名；撤回后成本重算，物理已切负荷不变。
- `shed` 撤回 id 为 `<负荷名>@<事件时间毫秒>`；已执行切负荷不可抹除，只追加补偿记录。
- `op:"retract"` 与独立 `retract` 事件等价。

## 语义规则

- **METER_ROLLBACK**：累积 kwh 出现负值，或相对活动读数单调性倒退且非撤回/更正，报错退出 1。
- **水位线** = 最大事件时间 - 1 分钟；低于水位线的事件记入 `late.log` 并作为增量更正应用。
- **费率联结**：窗口取覆盖其开始时刻、定义事件时间最新的费率；无费率则 `rate=0, rateMissing=true`。
- **成本目标**：最小化计费需量成本 `max_w (grossKw_w - shedKw_w) * rate_w`（需量峰值计费）。
- **平手规则**：成本相同取总切负荷更小；再相同按 load 字典序优先切字典序小的负荷。
- **最优性证明**：闭式解（水位法）+ 窗口数 ≤ 3 时穷举全部整数 kW 组合对照，
  结果写入 `settlement.json` 的 `exhaustive` 字段。

## 结构

- `src/engine.js` — 事件应用、撤回/补偿、窗口电量、迟到检测、METER_ROLLBACK
- `src/optimize.js` — 最优切负荷（闭式）与穷举对照
- `src/audit.js` — 汇总结算与输出装配
- `src/cli.js` / `bin/demand.js` — CLI
- `test/` — node:test 验收测试
