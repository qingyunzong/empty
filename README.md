# toollife

机加车间刀具寿命台账：按工单扣减寿命，支持撤销报工与补偿，输出可信剩余寿命。
Node.js 22，仅标准库，测试使用 `node:test`，单机离线。

## 用法

```sh
node cli.js toollife --in <dir> --out <dir>
node --test
```

## 输入（--in 目录）

- `tools.json`：`{ "materials": {"steel": 1, ...}, "tools": [{"tool_id", "max_life", "life"?}] }`
  - `materials` 为材料系数表，缺省材料系数为 1；`life` 缺省为 `max_life`。
- `operations.jsonl`：每行一个 op，含 `op_id`、`tool_id`、`type`：
  - `setup`：换刀/装夹，寿命重置为 `max_life`；
  - `cut`：`{material, amount}`，扣减 `amount * 材料系数`；
  - `regrind`：`{restore}`，恢复寿命但不超过 `max_life`。
- `undo.jsonl`（可缺省）：每行 `{ "undo_id"?, "op_id" }`，请求撤销某个 cut。

## 核心机制

1. cut 按材料系数扣寿命；regrind 恢复但封顶 `max_life`；setup 重置为满寿命。
2. undo 只能直接撤销“之后没有同刀活跃 op”的 cut（精确反向）；否则该 undo 被标记
   `COMPENSATED` 并生成 `compensate_op` 反向记录（加回扣减量、封顶 max）。
3. 同一 `op_id` 重放幂等（第二次 `NOOP`）；撤销与补偿成对且不可重复应用
   （重复 undo 同一目标一律 `NOOP`）。
4. cut 使寿命变负仍强制执行并记 `OVERUSE`；此后禁止再 cut（`BLOCKED_OVERUSE`），
   直到 regrind 或 setup（换刀）使寿命恢复非负。

## 输出（--out 目录）

- `tools_state.json`：`{ "tools": [{"tool_id", "max_life", "life", "overused"}] }`
- `history.jsonl`：按序记录每个 op / undo / compensate_op 的处理结果与 `life_after`。

## 退出码

- `0` 成功；`1` 用法或输入错误；`2` 未知刀具（`unknown tool: <id>`）。
