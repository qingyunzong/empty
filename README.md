# transfer.py — 幂等转账 CLI

纯 Python 3.11+ 标准库实现。一个系统目录（`--dir`，默认 `system/`）包含：

- `request.json` — 请求：两个账户 + 一笔带 `idemkey` 的转账
- `events.jsonl` — 仅追加事件日志，每条记录写后 `flush` + `fsync`
- `ledger.jsonl` — 仅追加账本，按 `idemkey + action` 去重（幂等）

## 请求 JSON

```json
{
  "idemkey": "tx-100",
  "accounts": {"alice": 1000, "bob": 500},
  "transfer": {"from": "alice", "to": "bob", "amount": 200},
  "failures": {"credit": false, "refund": false}
}
```

`failures` 用于注入永久失败（测试补偿路径），可省略。

## 命令

```bash
python transfer.py new --request req.json --dir sys   # 创建，状态 PENDING
python transfer.py run --dir sys                      # 执行到终态
python transfer.py crash --at after-debit-event --dir sys   # 模拟崩溃
python transfer.py recover --dir sys                  # 从事件日志恢复
python transfer.py state --dir sys                    # 输出状态与余额
```

崩溃点：`after-debit-event`（扣款事件后）、`after-debit-action`（扣款动作后）、
`after-credit-action`（加款动作后）。恢复时无成功事件的动作重放（账本幂等去重），
有成功事件的动作跳过。

## 状态机

`PENDING → PREPARED → COMPLETED`；加款永久失败：`PREPARED → COMPENSATING →
COMPENSATED`（反向退款）；补偿也失败：`COMPENSATING → FAILED`。

## 退出码

| 码 | 含义 |
|----|------|
| 0  | 成功（COMPLETED）或补偿完成（COMPENSATED） |
| 2  | 请求进行中（PENDING / PREPARED / COMPENSATING） |
| 4  | 参数错误（非法 JSON、非法请求、未知崩溃点等） |
| 10 | 永久失败（FAILED） |

## 测试

```bash
python -m unittest -v > result.txt 2>&1
```

测试通过子进程调用真实 CLI，逐格断言内联参考状态转移表
（`test_transfer.py` 中的 `TRANSITION_TABLE`）。
