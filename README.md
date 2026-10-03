# settlement-batch-audit

结算批次审计库与 CLI：在过账（post）、撤单更正（cancel）、额度冻结（freeze）组合下检查不变量，
并把失败批次收缩为可复现的最小反例。仅使用 Node.js 22 标准库与 `node:test`。

## 命令

- `post(id, account, amount)`：增加账户发生额并占用可用额度。
- `cancel(postId)`：生成金额相反的反向更正条目（不删除历史），恢复被占用的额度。
- `freeze(account, amount)`：增加冻结额，减少可用额度。

## 不变量

1. `NET_PLUS_FROZEN_WITHIN_LIMIT`：任意账户 已过账净额 + 冻结额 ≤ 限额（逐步检查）。
2. `CORRECTION_OPPOSITE_SIGN`：所有更正金额与原过账严格互为相反数。
3. `VOLUME_REPLAYABLE`：累计发生额与账户状态可由审计轨迹重放复现。

## CLI

```sh
node cli.js shrink plan.json
```

plan.json：

```json
{
  "limits": { "A": 100 },
  "commands": [
    { "op": "post", "id": "p1", "account": "A", "amount": 40 },
    { "op": "cancel", "postId": "p1" },
    { "op": "freeze", "account": "A", "amount": 10 }
  ]
}
```

- 安全：退出码 0，输出 `SAFE` 证书（不变量清单、命令数、重放哈希、最终状态）。
- 不安全：退出码 0，输出 `UNSAFE`、保留失败的最短子序列（长度相同取字典序最小）、
  被删命令、违约详情、最终状态与重放哈希（sha256）。
- 非法 id、循环更正、负金额等：退出码 1，stderr 输出 `INVALID_COMMAND: ...`。
- 用法/文件/JSON 错误：退出码 2。

## 测试

```sh
node --test 2>&1 | tee test-result.txt
```
