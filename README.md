# toollife

机加车间刀具寿命台账：按工单扣减寿命，支持操作员撤销报工（直接撤销或补偿反向记录），
为计划员提供可信剩余寿命。Node.js 22，仅标准库，测试用 `node:test`，单机离线。

## 用法

```sh
node cli.js toollife --in <dir> --out <dir>
node --test          # 运行测试
```

## 输入（--in 目录）

- `tools.json`：`{"tools":[{"tool_id","max_life","materials":{"<材料>":<系数>}}]}`
- `operations.jsonl`：每行一个 op
  - `setup`：`{"op_id","type":"setup","tool_id"}` 装刀/换刀，寿命重置为上限
  - `cut`：`{"op_id","type":"cut","tool_id","material","units"}` 扣减 `units * 材料系数`
  - `regrind`：`{"op_id","type":"regrind","tool_id","amount"}` 恢复寿命，不超过 `max_life`
- `undo.jsonl`（可选）：`{"undo_id","op_id"}`，在全部 op 之后按序处理

## 核心机制

1. **扣减/恢复**：cut 按材料系数扣寿命；regrind 恢复但 capped 于 `max_life`。
2. **撤销**：仅当目标 cut 之后同一把刀没有其它活跃 op（未被撤销/补偿的 setup/cut/regrind）
   时才直接撤销（回补扣减量）；否则拒绝直接撤销，生成成对的 `compensate_op` 反向记录
   （`comp:<undo_id>`），精确冲销该 cut 的扣减，保留完整审计轨迹。补偿是精确反向，
   不做上限截断，因此剩余寿命可能高于 `max_life`（如示例中 T1=103）。
3. **幂等**：同一 `op_id` 重放记 `noop`；同一 `undo_id` 或同一 op 的重复撤销记 `noop`；
   撤销与补偿成对且只应用一次。
4. **OVERUSE**：cut 使寿命为负时仍强制记账并打 `OVERUSE` 标记；此后禁止再 cut，
   直到 regrind 使寿命回到非负或 setup 换刀重置。

## 输出（--out 目录）

- `tools_state.json`：每把刀的 `remaining_life`（可为负）与 `status`（`OK`/`OVERUSE`）
- `history.jsonl`：全部事件流水（op/undo/compensate_op），含 `result`
  （`applied`/`rejected`/`noop`/`compensated`）与 `remaining_after`

## 退出码

- `0` 成功；`2` 输入错误（未知刀具、未知材料、JSON 解析失败、缺文件等）；`1` 其它错误

## 示例

```sh
node cli.js toollife --in examples/in --out examples/out
```
