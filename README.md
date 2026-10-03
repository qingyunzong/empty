# offline-settlement

离线商户结算库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 工作流

指令（JSON 文件）：`{"idempotencyKey":"...","account":"...","amount":整数,"failPost":false}`

每个指令依次执行：冻结额度（`FREEZE`）→ 登记应付账款（`PAYABLE_POSTED`）→ 确认结算（`SETTLED`）。
每步先把事件追加到日志目录的 `events.jsonl`，再更新内存状态。
`failPost=true` 时登记确定性失败：记录 `PAYABLE_FAILED`，补偿解冻（`UNFREEZE`），
状态转为 `FAILED`，绝不确认结算。

状态机：`PENDING → FROZEN → SETTLED`，或 `FROZEN → COMPENSATED → FAILED`。非法转移抛
`ILLEGAL_TRANSITION`。金额必须为正整数。

幂等：相同 `idempotencyKey` 重复提交返回原证书，不重复扣款/加款；证书可从事件日志完全重建。

## CLI

```
node cli.js init <logDir> <accounts.json>   # 初始化日志目录与账户余额
node cli.js submit <logDir> <command.json>  # 执行指令，输出 JSON 证书
node cli.js rebuild <logDir>                # 从日志重建状态，输出账户/结算/序号/哈希
```

错误时退出码为 1，输出 `{"error":"CODE","message":"..."}`。

## 测试

```
node --test
```
