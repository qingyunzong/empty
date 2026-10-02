# tool-life

按主轴负载推算刀具剩余寿命，并在质量复检（QC）晚到时更正已加工零件的风险等级。
Node.js 22，仅标准库，离线单机运行。

## 输入

`--in` 目录下的 `*.jsonl`（按文件名排序拼接，行序即到达序），每行一个事件：

```json
{"type":"load","eventTs":1,"tool":"T1","part":"P1","force":120,"seconds":3,"op":"l1"}
{"type":"change","eventTs":0,"tool":"T1","newLife":50,"op":"c1"}
{"type":"qc","eventTs":9,"part":"P1","ok":true,"op":"q1"}
{"type":"retract","eventTs":10,"kind":"load","id":"l1"}
```

- `op` 是事件 id；`retract(kind,id)` 撤回对应事件（可撤回 load / change / qc）。
- 水位线 = 已见最大 eventTs − 4 秒；到达时 eventTs 低于水位线的事件记入 `late.log`。
- 磨损非线性：`wear = seconds * (force / 额定)^2`，额定为 100（`--rated-force` 可调）。
- `change` 开启新寿命段；段内累计磨损 > 寿命的瞬间输出 EXHAUST（恰好磨到 0 不算超额）。
- 撤回 load 回滚磨损，被误判 EXHAUST 的后续段自动恢复（整体重算，天然一致）。
- 同一 part 多个 qc：取未撤回中 eventTs 最新者，平手按 `op` id 大者。
- qc `ok=false` 从该 eventTs 起对同刀后续零件产生 SUSPECT 风险链，`ok=true` 清除；
  撤回 qc 会把 part 从 GOOD 拉回 UNKNOWN 并重算风险链。
- `newLife <= 0` 报 `LIFE_INVALID`，该 change 被跳过，CLI 退出码 1。

## 使用

```bash
node bin/tool.js life --in data --out out
# 或 npm link 后: tool life --in data --out out
```

输出到 `--out`：

- `tools.jsonl` — 每刀一行：状态、当前段寿命/已耗/剩余、EXHAUST 时刻、全部寿命段明细
- `parts.jsonl` — 每零件一行：`state`(GOOD/BAD/UNKNOWN)、`risk`(OK/SUSPECT/EXHAUSTED)、生效 qc
- `risk.json` — 汇总：水位线、超额刀具、风险零件、计数、错误（含 LIFE_INVALID）
- `late.log` — 迟到事件（eventTs 低于到达时水位线）

## 测试

```bash
node --test
```
