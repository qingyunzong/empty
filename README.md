# tool-life

机加工产线刀具寿命与零件风险推算引擎。Node.js 22，仅标准库，单机离线。

## 输入

`--in` 目录下所有 `*.jsonl`（按文件名排序拼接），每行一个事件：

```json
{"type":"load",   "eventTs":10000, "tool":"T1", "part":"P1", "force":200, "seconds":1, "op":"l1"}
{"type":"change", "eventTs":0,     "tool":"T1", "newLife":10, "op":"c1"}
{"type":"qc",     "eventTs":15000, "part":"P1", "ok":false,   "op":"q1"}
{"type":"retract","eventTs":40000, "kind":"load", "id":"l1"}
```

## 语义

- **磨损**：`wear = seconds * (force / ratedForce)^2`（`ratedForce` 默认 100，`--rated-force` 可调），按 tool 在最近一次 `change` 开启的寿命段内累计。
- **EXHAUST**：段内累计磨损**严格大于** `newLife` 的瞬间输出 EXHAUST；恰好磨到 0（remaining == 0）不算超额（浮点容差 1e-9 相对误差）。
- **水位线**：`watermark = max(eventTs) - 4000ms`（`--watermark-delay-ms` 可调）。事件到达时 `eventTs < 当前水位线` 记为迟到，写入 `late.log`。
- **撤回**：`retract(kind,id)` 移除对应 `op` 的事件并全量重算——撤回 load 回滚磨损、可恢复被误判 EXHAUST 的后续段；撤回 qc 把零件拉回 UNKNOWN 并重算同刀后续风险。
- **QC 仲裁**：同一 part 多个 qc 取未撤回、eventTs 最大者；平手取 op id 字典序最大者。
- **风险链**（每把刀按零件首次 load 时间排序）：
  - qc ok → `GOOD`，并重置链上嫌疑；
  - qc !ok → `BAD`，后续未检零件升为 `RISK`；
  - 无 qc → 刀具超额期间加工或链上有嫌疑 → `RISK`，否则 `UNKNOWN`；
  - `change`（换新刀寿命）会重置链上嫌疑。
  - 零件跨多把刀时取最差评级。

## CLI

```sh
node bin/tool.js life --in <dir> --out <dir> [--rated-force N] [--watermark-delay-ms N]
# 或 npm link 后： tool life --in <dir> --out <dir>
```

输出到 `--out` 目录：

- `tools.jsonl`：每把刀一行，含各寿命段 wear/remaining/exhausted/exhaustAt；
- `parts.jsonl`：每个零件一行，含 qc 仲裁结果与最终 risk；
- `risk.json`：汇总（水位线、各风险计数、RISK/BAD 清单、EXHAUST 记录、错误清单）；
- `late.log`：迟到事件（`LATE kind=... id=... eventTs=... watermark=...`）。

错误（不中断处理，退出码仍为 0）：`LIFE_INVALID`（newLife<=0 的 change 被跳过）、`RETRACT_MISS`、`PARSE_ERROR`、`EVENT_INVALID`，打印到 stderr 并计入 `risk.json.errors`。

## 测试

```sh
node --test
```
