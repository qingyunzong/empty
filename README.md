# 代理行头寸调拨两阶段提交仿真（2PC CLI）

Node.js 22、仅标准库、单机离线。协调者（`COORD`）与参与方（`P@<acct>`）在同一进程内
通过**帧**通信，由虚拟时钟驱动事件堆推进，支持丢包、重复、乱序、分帧与篡改注入，
并实现两阶段状态机、借方额度冻结、WAL 崩溃恢复与哈希链决定证书。

## 运行

```sh
node cli.js <scenario.json>   # 运行场景，stdout 输出 JSON 结果
node --test                   # 运行全部验收测试
```

## 协议

消息字段：`tx`、`phase`（`prepare`/`vote`/`commit`/`abort`/`ack`）、`acct`、`amount`
（借方为负、贷方为正）、`seq`（发送方单调序号）、`ack`（`yes`/`no`/`ok`/`nack`）、
`reason`。帧 = `{"body": <JSON 消息>, "crc": crc32(body)}`；帧可按
`network.fragmentSize` 切成分片，接收方按 `frameId/idx/total` 重组，CRC 校验失败即丢弃。

流程：

1. 协调者对每条腿发送 `prepare`，并按 `retryInterval` 重传未投票者；
   `prepareTimeout`（虚拟时钟）到期未集齐投票则决定 `abort`。
2. 参与方 `prepare` 时**冻结借方额度**（`balance - frozen >= -amount`）并**校验贷方限制**
   （`balance + amount <= creditLimit`），先把投票写入 WAL 再应答；
   重复 `prepare` 同 tx 直接返回原投票（即使已 commit/abort，绝不再冻结）。
3. 全部 `yes` → 协调者写 `decision=commit` 日志后广播 `commit`；任一 `no` 或超时 → `abort`。
4. 参与方 `commit`：写 commit 日志 → 应用转账（解冻并入账）→ 回 `ack`；
   重复 `commit` 幂等（已应用则直接重发 ack）。`abort`：解冻并回 `ack`；
   已 committed/applied 的 tx 收到 `abort` 会拒绝并记协议错——**不得既扣又解冻**。
5. 决定产生时协调者把 `{index, tx, decision, reason, votes, at, prevHash}` 追加进
   哈希链（sha256），输出 `certificate.valid` 可离线重算验证。

## 崩溃恢复（WAL）

每个节点的持久状态只有 WAL（重放重建账户/冻结/tx 状态）。故障点（`faults[].point`）：

- `after-prepare-log`：参与方写完 prepare 投票日志、未应答即崩溃；
  重启后协调者重传 prepare，参与方返回原投票。
- `after-commit-log`：参与方写完 commit 日志、未应用即崩溃；
  重启重放时立即补应用（`apply`），再对重传的 commit 回 ack。
- `after-apply-before-ack`：应用后未发 ack 即崩溃；
  重启后协调者重传 commit，参与方幂等重发 ack。
- `after-decision-log`：协调者写完 decision 日志、未广播即崩溃；
  重启按 WAL 续传决定（未决 tx 续传 prepare 并重算剩余超时）。

恢复结果确定：同一 WAL 重放得到同一状态；`restartDelay`（虚拟时间）后节点重启。

## 场景文件格式

```jsonc
{
  "accounts": { "A": { "balance": 100, "creditLimit": 1000 } },   // 必填
  "participants": { "P1": ["A", "B"] },        // 可选；默认每账户一个参与方 P@<acct>
  "txs": [ { "tx": "t1", "at": 0,             // at 可选，虚拟时间
             "legs": [ { "acct": "A", "amount": -30 }, { "acct": "B", "amount": 30 } ] } ],
  "prepareTimeout": 50, "retryInterval": 10, "maxTime": 5000,
  "network": {
    "fragmentSize": 20, "reorder": true, "seed": 7,
    "faults": [
      { "msgIndex": 0, "action": "drop", "times": 1 },   // 第 N 条发送的消息
      { "to": "P@B", "phase": "vote", "action": "drop" },// 或按 from/to/phase/tx/acct 匹配
      { "phase": "prepare", "acct": "A", "action": "dup:200" }  // drop/dup/dup:N/corrupt/delay:N
    ]
  },
  "faults": [ { "node": "P@A", "tx": "t1", "point": "after-commit-log", "restartDelay": 5 } ],
  "ops": [ { "op": "status", "tx": "t1" }, { "op": "pending" } ]
}
```

校验规则（违反即协议错 exit 2）：账户余额/额度为有限数；tx id 唯一；每条 tx 的腿
非空、账户存在且不重复、金额非零且**总和为 0**。

## 输出

`results`（每 tx 决定/原因/各腿 ack）、`balances`（余额+冻结+额度）、`pending`
（参与方超时未决清单，state=prepared）、`certificate`（哈希链+`valid`）、`ops`
结果、`stats`（发送/丢弃/重复/篡改/CRC 错误/交付计数）、`errors`。

## 退出码

- `0`：正常（含 CREDIT_LIMIT / PREPARE_TIMEOUT 导致的 abort）
- `2`：协议错（场景非法、非法帧/消息、abort-after-commit 等）
- `3`：余额不足（任一 tx 因 `INSUFFICIENT_FUNDS` 中止）
- `4`：未知 tx（`ops` 查询不存在的 tx，或节点收到未知 tx 的 commit/abort/vote）

优先级：2 > 4 > 3。

## 真实输出记录

以下均为本仓库实际运行输出（节选），环境 Node v22.22.1。

### `node cli.js scenarios/commit.json` → exit 0

分帧（20 字节）+ 乱序 + 首条 prepare 丢失一次 + vote 重复，仍收敛 commit：

```json
{
  "results": { "t1": { "decision": "commit", "reason": null, "acks": { "A": true, "B": true } } },
  "balances": {
    "A": { "participant": "P@A", "balance": 70, "frozen": 0, "creditLimit": 1000 },
    "B": { "participant": "P@B", "balance": 30, "frozen": 0, "creditLimit": 1000 }
  },
  "pending": [],
  "certificate": { "valid": true, "chain": [ { "index": 0, "tx": "t1", "decision": "commit",
    "reason": "", "votes": { "B": "yes", "A": "yes" }, "at": 18,
    "prevHash": "0000...0000",
    "hash": "db0c102eff312c8430eda388c08570e1fab5934d27383d8fda0bab842624610e" } ] },
  "stats": { "sent": 9, "dropped": 1, "duplicated": 2, "corrupted": 0, "crcErrors": 0, "delivered": 8 },
  "errors": []
}
```

### `node cli.js scenarios/prepare-timeout.json` → exit 0

B 的 vote 与发向 B 的 abort 全部丢弃：prepare 超时 abort，A 解冻，B 滞留未决清单：

```json
{
  "results": { "t1": { "decision": "abort", "reason": "PREPARE_TIMEOUT", "acks": { "A": true, "B": false } } },
  "pending": [ { "participant": "P@B", "tx": "t1", "acct": "B", "amount": 40 } ],
  "certificate_chain_0": { "decision": "abort", "reason": "PREPARE_TIMEOUT", "votes": { "A": "yes" },
    "hash": "151373346d61c15fcee8d515f1e4303327d7771a57c33e696c1a1db3bfd3fcb2" }
}
```

### `node cli.js scenarios/credit-limit.json` → exit 0

```json
{ "results": { "t1": { "decision": "abort", "reason": "CREDIT_LIMIT", "acks": { "A": true, "B": true } } },
  "balances": { "A": { "balance": 100, "frozen": 0 }, "B": { "balance": 0, "frozen": 0 } } }
```

### `node cli.js scenarios/insufficient.json` → exit 3

```json
{ "results": { "t1": { "decision": "abort", "reason": "INSUFFICIENT_FUNDS", "acks": { "A": true, "B": true } } },
  "balances": { "A": { "balance": 10, "frozen": 0 }, "B": { "balance": 0, "frozen": 0 } } }
```

### `node cli.js scenarios/unknown-tx.json` → exit 4

```json
{ "results": { "t1": { "decision": "commit" } },
  "ops": [ { "op": "status", "tx": "ghost-tx", "error": "UNKNOWN_TX" } ] }
```

### `node cli.js scenarios/protocol-error.json` → exit 2

```
protocol error: tx t1: legs must sum to zero
```

### `node cli.js scenarios/crash-recovery.json` → exit 0

三个故障点 + 协调者重启同时注入（t1: after-prepare-log，t2: after-commit-log +
COORD after-decision-log，t3: after-apply-before-ack），恢复后全部确定性 commit：

```json
{ "results": { "t1": { "decision": "commit" }, "t2": { "decision": "commit" }, "t3": { "decision": "commit" } },
  "balances": { "A": 90, "B": 10, "C": 80, "D": 20, "E": 70, "F": 30 },
  "pending": [], "certificate": { "valid": true, "entries": 3 }, "errors": [] }
```

### `node --test`

```
# tests 2
# pass 2
# fail 0
```

验收覆盖（`test/acceptance.test.js`）：

1. prepare 超时 abort（A 解冻、B 入未决清单、证书记 abort）；
2. commit 后重发 prepare：返回原投票 `yes`，余额/冻结不变，无错误；
3. 贷方限制拒绝：`CREDIT_LIMIT` 投票 no → abort，无余额变动；
4. 三个故障点 + 协调者 after-decision-log 逐一与组合恢复，结果与参考实现一致；
5. 5 账户 × 8 消息全枚举：每条消息 ∈ {正常, 丢失, 重复}（3^8=6561）× 乱序开关，
   共 13122 个场景与独立 2PC 参考实现（`src/reference.js`）对照，决定、余额、
   未决清单、证书全部一致。

## 代码结构

- `cli.js` — 命令行入口（`runCliFile` 可进程内调用，便于测试）
- `src/engine.js` — 虚拟时钟事件堆、帧分片信道、丢/重/乱序/篡改注入、崩溃与重启
- `src/frame.js` / `src/crc.js` — 帧编解码、CRC32、分片重组
- `src/coordinator.js` — 协调者状态机（WAL：begin/vote/decision/ack + 证书链）
- `src/participant.js` — 参与方状态机（WAL：prepare/commit/apply/abort，冻结与恢复）
- `src/simulate.js` — 场景校验与运行、输出汇总、退出码
- `src/reference.js` — 独立 2PC 参考实现（枚举对照用）
- `src/certificate.js` — 哈希链决定证书（sha256 prevHash 链）
