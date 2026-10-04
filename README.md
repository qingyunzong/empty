# idempotent-payments

离线幂等支付/撤销库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 设计

- **幂等**：每个请求携带客户端 `requestId`。首个成功提交的结果随事务一并写入
  WAL 的幂等表；相同 `requestId` 的重复请求直接返回首次结果，不会重复扣款/退款。
- **WAL**：每个事务写 `begin`（含操作意图 op+params）、`data`（业务变更）、
  `commit`（携带版本号 seq）三类记录，逐条 fsync。重启恢复时，无 `commit`
  记录的事务回滚，已提交事务按 seq 重放。
- **MVCC**：余额、交易、幂等结果均为版本化映射（key → [{seq, value}]），
  读取按快照 seq 取最新可见版本，未提交数据天然不可见。
- **崩溃点**：
  - `P1`：业务变更写入 WAL 后、`commit` 前崩溃 → 重启回滚，`retry` 以同一
    `requestId` 创建全新交易（新 txId），只扣一次款。
  - `P2`：`commit` 落盘后、响应返回前崩溃 → 提交生效，`retry` 返回原交易的
    首次结果，不重复扣款。
- **撤销**：只能撤销 `paid` 状态的支付交易；重复撤销（同 requestId）返回首次
  撤销结果；未知交易返回 `E_NOT_FOUND`；对已完成撤销的交易换新 requestId
  返回 `E_STATE`。

## CLI

```sh
node src/cli.js --db <dir> pay    --request-id R --account A --amount 100 [--crash-at P1|P2]
node src/cli.js --db <dir> cancel --request-id R --tx tx-1 [--crash-at P1|P2]
node src/cli.js --db <dir> retry  --request-id R
node src/cli.js --db <dir> get    --tx tx-1 | --account A | --request-id R
```

退出码：`0` 成功，`1` 错误结果（`E_*`，JSON 仍输出），`2` 模拟崩溃（无响应输出）。

## 测试

```sh
node --test
```

除验收场景外，`test/payments.test.js` 对请求序列做穷举枚举（长度 3 全量 +
长度 8 随机），将真实 WAL/MVCC 实现与一个独立的纯内存映射表参考模型逐步
对照：每次响应、最终余额与全部状态必须一致。
