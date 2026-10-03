# tx-cancel-engine

离线交易撤销引擎与 CLI。Node.js 22，仅标准库与 `node:test`，无第三方依赖。

## 使用

```bash
node . cancel input.json output.json   # 正常退出码 0；坏输入退出码 1
node --test                            # 运行测试
```

## 领域模型

一笔交易由至多 4 个阶段组成，阶段类型为 `trade`（成交）、`fee`（费用）、
`freeze`（冻结）、`settlement`（结算）。撤销沿四阶段逆向补偿。

### 输入（input.json）

```jsonc
{
  "transactions": [
    {
      "id": "tx1",
      "stages": [
        {
          "id": "s-trade",
          "kind": "trade",            // trade | fee | freeze | settlement
          "account": "A",
          "amount": 50,               // 正数
          "status": "posted",         // posted | reconciled（已对账）
          "dependsOn": ["s-fee"]      // 子阶段：必须先于本阶段完成补偿
        }
      ]
    }
  ],
  "batches": [
    {
      "id": "b1",
      "domains": ["trade", "fee", "freeze", "settlement"],  // 允许批次域
      "recoverable": { "A": 250 }   // 该批次对每个账户的可恢复额度（缺省账户额度为 0）
    }
  ],
  "requests": [
    { "idempotencyKey": "req-1", "transactionId": "tx1" }
  ]
}
```

### 撤销语义

- **逆向补偿顺序**：`dependsOn` 表示补偿顺序依赖——列出的子阶段必须先于父
  阶段完成补偿。标准链路 `trade → fee → freeze → settlement` 的补偿顺序为
  `settlement → freeze → fee → trade`。
- **批次放置**：每笔补偿只能放入允许该阶段类型的批次域；同一撤销请求产生
  的补偿序列中，放入同一批次的同账户补偿总额不得超过该批次的可恢复额度。
  求解器先传播不可行批次（域/额度剪枝 + 前向检查），再回溯寻找可行序列。
- **红冲**：已对账（`reconciled`）阶段的补偿动作为 `reversal`（红冲），其余
  阶段为 `delete`。
- **部分成功**：完整序列不可行时，应用最长的可行前缀（`PARTIAL`），其余阶段
  进入 `pending`；后续针对同一交易的请求会从待决阶段继续（未决补偿可恢复），
  补偿序列随请求增量维护。
- **幂等**：相同 `idempotencyKey` 的请求重放首次存储的结果（`replayed: true`），
  不改变任何状态。
- **冲突路径**：不可行时输出 `conflictPath`——从受阻阶段沿父阶段链到根阶段
  的阶段 id 路径。

### 输出（output.json）

```jsonc
{
  "results": [
    {
      "idempotencyKey": "req-1",
      "transactionId": "tx1",
      "status": "COMPLETED",        // COMPLETED | PARTIAL | REJECTED
      "reason": null,               // TRANSACTION_NOT_FOUND | NOTHING_TO_CANCEL
      "replayed": false,
      "sequence": [                 // 本请求应用的补偿（有序）
        { "stageId": "s-settle", "kind": "settlement", "account": "A",
          "amount": 100, "batchId": "b1", "action": "delete" }
      ],
      "pending": [],                // 仍未决的阶段 id
      "conflictPath": null,
      "compensated": ["s-settle"]   // 该交易累计已补偿阶段（增量维护）
    }
  ],
  "state": { "transactions": [ /* 每交易最终阶段状态与累计补偿序列 */ ] }
}
```

### 退出码

- `0`：输入合法，全部请求已处理（单个请求仍可能是 `REJECTED`）。
- `1`：坏输入——参数错误、文件不可读、JSON 非法或模式校验失败（未知阶段
  引用、依赖环、重复 id、非法金额/额度/域等）。

## 测试

`test/engine.test.js` 覆盖四条验收（四阶段逆序、已对账红冲、额度不足部分
成功且未决可恢复、幂等重放），另含回溯、冲突路径、域不可行、按账户额度等
用例；并以 ≤4 阶段暴力枚举批次分配作为参考求解器，与回溯引擎做 300 例
随机交叉对照（`test/helpers.js` 的 `referenceAssignment`）。
`test/cli.test.js` 覆盖 CLI 退出码与输出文件（沙箱禁止派生子进程，故 CLI
经 `main(argv)` 进程内测试；真实 `node . cancel ...` 入口已用
`examples/input.json` 验证）。
