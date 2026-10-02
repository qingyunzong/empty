# offline-settlement

离线商户结算库与 CLI：可重放的三步工作流（冻结额度 → 登记应付账款 → 确认结算），
每步先把事件追加到 JSONL 事件日志，再更新内存状态。仅使用 Node.js 标准库与 `node:test`。

## 用法

```bash
# 提交结算指令（输入为 JSON 文件，输出为 JSON 证书）
node src/cli.js submit --log <日志目录> --input command.json

# 从日志目录重建状态（容忍乱序与重复事件，按 seq 去重排序后重放）
node src/cli.js rebuild --log <日志目录>
```

指令格式：

```json
{ "idempotencyKey": "k1", "account": "merchant-a", "amount": 250, "failPost": false }
```

- `amount` 必须为正整数；可选 `initialBalance` 指定新账户开户额度（默认 10000）。
- `failPost: true` 时登记应付账款确定性失败：日志写入 `COMPENSATE`（解冻补偿）与
  `FAIL` 事件，最终状态 `FAILED`，额度还原，绝不确认结算。
- 相同 `idempotencyKey` 重复提交直接返回原证书，不重复扣款或加款。

状态机：`PENDING → FROZEN → (POST) → SETTLED`，失败路径
`FROZEN → COMPENSATED → FAILED`。非法转移抛出 `ILLEGAL_TRANSITION`。

错误时退出码为 1，输出 `{"error":"CODE","message":"..."}`；
错误码：`INVALID_INPUT` / `INSUFFICIENT_FUNDS` / `ILLEGAL_TRANSITION` /
`UNKNOWN_COMMAND` / `UNKNOWN_KEY` / `INTERNAL`。

## 测试

```bash
node --test
```
