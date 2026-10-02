# 商户退款风控服务

Node.js 22、仅标准库、单机离线。JSON 行帧协议 + 退款风控核心 + WAL 持久化 + CLI。

## 运行

```bash
node cli.js <ops.jsonl> [--config config.json] [--wal wal.bin] [--audit]
node --test
```

- `ops.jsonl`：每行一个入站帧（见下文协议）。
- `--config`：覆盖默认配置 `{budgetLimit:1000, slaMs:1000, highRiskTags:["high"]}`。
- `--wal`：WAL 文件路径，默认 `<ops.jsonl>.wal`。已存在时先恢复重放，再处理新输入。
- `--audit`：在快照后追加输出完整审计链（含每条事件的 hash）。

退出码：`0` 正常；`2` 帧错误（非法 JSON / 缺字段 / 非法 seq）；`3` 同 key 金额冲突；`4` 超可退余额。

## 协议层（src/protocol.js）

入站帧：`{"seq":N, "ack":M, "t":T, "op":{...}}`，出站：`{"ack":N, "result":{...}}`。

- **分帧**：每行一个 JSON 值；解析失败即帧错误（exit 2）。
- **重传/去重**：`seq < expected` 视为重传，直接返回该 seq 首次决策时缓存的结果（输出带 `"dup":true`），绝不重复执行。
- **乱序**：`seq > expected` 缓存到缺口填补；业务核心永远按 seq 顺序看到请求。
- **虚拟时钟**：每帧携带发送时刻 `t`，服务时钟只前进；`tick` 操作显式推进。时钟前进时触发 SLA 超时扫描。

操作：`refund{key,order,amount,riskTag,paid}`、`approve{key}`、`reject{key}`、`expire{key}`、`reverse{key}`、`tick{to}`。

## 业务核心（src/core.js）

- **幂等**：同 key 同金额重复 `refund` 返回首次决策结果；同 key 不同金额返回 `conflict`（exit 3），历史记录不变。
- **可退余额**：退款不得超过订单 `paid - refunded`，超出即 `REJECTED/LIMIT_EXCEEDED`（exit 4）；approve 时复检。
- **风险预算**：`highRiskTags` 命中的退款占用滚动预算。`approve` 扣预算，`reject/expire/reverse` 释放。预算不足则排队（FIFO，队头阻塞）；到 SLA 截止时间仍未获得预算自动 `REJECTED/BUDGET_EXHAUSTED`；同一截止时刻多笔并列按 key 升序决胜。预算释放后立即按 FIFO 补位。
- **撤销恢复**：`reverse` 已 approve 的退款生成 `reverseRefund` 审计事件，回补预算与可退余额；原审批事件保留，历史不可改。
- **审计**：每个状态变更追加事件，`hash = sha256(prevHash|seq|event|canonical(data))` 链式推进，快照输出链头 `auditHash`；`verifyAudit()` 可重放校验防篡改。

## WAL 与故障点（src/wal.js）

每条记录 `[len][payload][crc32]`，写入即 `fsync`。故障点定义：

1. **决策前**：帧未入 WAL，重启后不存在，无副作用。
2. **日志后**：帧与决策结果已入 WAL，重启重放按 seq 幂等应用，不二次扣减。
3. **响应前**：客户端未收到 ack 会重传，协议层从日志重建的结果缓存直接重放原响应。

恢复时校验 CRC，截断撕裂/损坏的尾部记录后继续追加。重放只按 WAL 中已决定的 seq 顺序应用，预算与余额精确复原。

## 输出

每个被决定的帧一行 `{"ack","result"}`，最后一行快照：每 key 状态与拒绝码、预算占用、排队 key、订单余额、审计 hash。

## 验收对照

| # | 场景 | 测试 |
|---|------|------|
| 1 | 重复 refund | `test/core.test.js` duplicate/conflict；`test/protocol.test.js` retransmission |
| 2 | 乱序 approve 先于 refund | `test/protocol.test.js` out-of-order；`test/cli.test.js` |
| 3 | 预算并列同刻按 key 决胜 | `test/core.test.js` budget tie / simultaneous SLA expiry |
| 4 | expire 与迟到 approve | `test/core.test.js` expire then late approve |
| 5 | ≤6 请求枚举对照串行参考 | `test/enumeration.test.js`（6 模板全枚举 ≤6 长度 55,986 条 + 8 模板 ≤5 全枚举 37,449 条 + 20,000 条确定性采样，逐请求结果与最终状态同 `testlib/reference.js` 对照） |

WAL 故障点矩阵见 `test/wal.test.js`；CLI 退出码见 `test/cli.test.js`。

## 真实输出

### `node --test`

```
ok 1 - test/cli.test.js
ok 2 - test/core.test.js
ok 3 - test/enumeration.test.js
ok 4 - test/protocol.test.js
ok 5 - test/wal.test.js
# tests 5
# pass 5
# fail 0
```

### 验收 1+3：重复 refund 与同 key 冲突（exit 3）

```
$ node cli.js examples/duplicate-refund.jsonl --config examples/config.json --wal /tmp/ex1.wal
{"ack":0,"result":{"status":"ok","key":"k1","state":"PENDING"}}
{"ack":1,"result":{"status":"ok","key":"k1","state":"APPROVED"}}
{"ack":2,"result":{"status":"ok","key":"k1","state":"APPROVED"}}
{"ack":3,"result":{"status":"conflict","code":"CONFLICT","key":"k1","originalAmount":40,"amount":55,"state":"APPROVED"}}
{"snapshot":{"now":30,"budget":{"limit":50,"used":40,"available":10},"queue":[],"refunds":{"k1":{"state":"APPROVED","order":"o1","amount":40,"riskTag":"high","budgetHeld":true,"rejectCode":null}},"orders":{"o1":{"paid":100,"refunded":40,"remaining":60}},"auditHash":"6d02ad80ee57132c7528375869b9c27200ef4375137b77044e3d872b2702c0a8","auditLength":4}}
exit=3
```

### 验收 2：乱序 approve 先于 refund（exit 0）

```
$ node cli.js examples/out-of-order.jsonl --config examples/config.json --wal /tmp/ex2.wal
{"ack":0,"result":{"status":"ok","key":"k1","state":"PENDING"}}
{"ack":1,"result":{"status":"ok","key":"k1","state":"APPROVED"}}
{"ack":1,"result":{"status":"ok","key":"k1","state":"APPROVED"},"dup":true}
{"snapshot":{"now":10,"budget":{"limit":50,"used":40,"available":10},"queue":[],"refunds":{"k1":{"state":"APPROVED","order":"o1","amount":40,"riskTag":"high","budgetHeld":true,"rejectCode":null}},"orders":{"o1":{"paid":100,"refunded":40,"remaining":60}},"auditHash":"6d02ad80ee57132c7528375869b9c27200ef4375137b77044e3d872b2702c0a8","auditLength":4}}
exit=0
```

seq 1 的 approve 先到达但被缓存，seq 0 到达后按序交付；重传的 seq 1 返回 `dup` 结果。注意 auditHash 与顺序执行完全相同。

### 验收 3：预算并列同刻按 key 决胜（exit 0）

```
$ node cli.js examples/budget-tie.jsonl --config examples/config.json --wal /tmp/ex3.wal --audit
{"ack":0,"result":{"status":"ok","key":"k1","state":"PENDING"}}
{"ack":1,"result":{"status":"ok","key":"k3","state":"PENDING"}}
{"ack":2,"result":{"status":"ok","key":"k2","state":"PENDING"}}
{"ack":3,"result":{"status":"ok","key":"k1","state":"APPROVED"}}
{"ack":4,"result":{"status":"ok","now":110}}
{"snapshot":{"now":110,"budget":{"limit":50,"used":40,"available":10},"queue":[],"refunds":{"k1":{"state":"APPROVED",...},"k2":{"state":"REJECTED",...,"rejectCode":"BUDGET_EXHAUSTED"},"k3":{"state":"REJECTED",...,"rejectCode":"BUDGET_EXHAUSTED"}},...,"auditHash":"44ab0cd882dd4dfc0879272e222225717152ade9740ffcd3df36afe186bb85b7","auditLength":10}}
{"audit":{"seq":9,"event":"refundRejected","data":{"key":"k2","code":"BUDGET_EXHAUSTED","reason":"budget not granted before SLA deadline"},"hash":"216df11352918844652e1052edd5564a64a753472f0a9bab3a4ac100db37a52f"}}
{"audit":{"seq":10,"event":"refundRejected","data":{"key":"k3","code":"BUDGET_EXHAUSTED","reason":"budget not granted before SLA deadline"},"hash":"44ab0cd882dd4dfc0879272e222225717152ade9740ffcd3df36afe186bb85b7"}}
exit=0
```

k2、k3 同刻（t=110）到期，审计 seq 9→10 按 key 升序决胜（k2 先于 k3）。

### 验收 4：expire 与迟到 approve + 撤销恢复（exit 0）

```
$ node cli.js examples/expire-late-approve.jsonl --config examples/config.json --wal /tmp/ex4.wal --audit
{"ack":0,"result":{"status":"ok","key":"k1","state":"PENDING"}}
{"ack":1,"result":{"status":"ok","key":"k1","state":"EXPIRED"}}
{"ack":2,"result":{"status":"ok","key":"k1","state":"EXPIRED"}}
{"ack":3,"result":{"status":"ok","key":"k2","state":"PENDING"}}
{"ack":4,"result":{"status":"ok","key":"k2","state":"APPROVED"}}
{"ack":5,"result":{"status":"ok","key":"k2","state":"REVERSED"}}
{"snapshot":{"now":50,"budget":{"limit":50,"used":0,"available":50},"queue":[],"refunds":{"k1":{"state":"EXPIRED",...},"k2":{"state":"REVERSED",...}},"orders":{"o1":{"paid":100,"refunded":0,"remaining":100}},"auditHash":"c1d476cc52828bc0758cff7158dcfa20c3ac3a705d809a5eea4d0c8c27d0b229","auditLength":8}}
{"audit":{"seq":7,"event":"budgetReleased","data":{"key":"k2","amount":40,"budgetUsed":0},"hash":"7ba1c6858178618ec930ebe4201e4a870e7dfd78942cf23183a617451716619c"}}
{"audit":{"seq":8,"event":"reverseRefund","data":{"key":"k2","order":"o1","amount":40},"hash":"c1d476cc52828bc0758cff7158dcfa20c3ac3a705d809a5eea4d0c8c27d0b229"}}
exit=0
```

迟到的 approve（ack 2）对终态 k1 无效；k2 撤销后生成 `reverseRefund`，预算与可退余额回补（`remaining` 回到 100）。

### 重启重放（同一 WAL 再跑一次）

```
$ node cli.js examples/out-of-order.jsonl --config examples/config.json --wal /tmp/ex2.wal   # 第二次
{"ack":0,"result":{"status":"ok","key":"k1","state":"PENDING"},"dup":true}
{"ack":1,"result":{"status":"ok","key":"k1","state":"APPROVED"},"dup":true}
{"ack":1,"result":{"status":"ok","key":"k1","state":"APPROVED"},"dup":true}
{"snapshot":{...,"orders":{"o1":{"paid":100,"refunded":40,"remaining":60}},"auditHash":"6d02ad80ee57132c7528375869b9c27200ef4375137b77044e3d872b2702c0a8","auditLength":4}}
exit=0
```

快照与 auditHash 逐字节一致，`refunded` 仍为 40：重放不二次扣减。

## 文件结构

- `cli.js` — 参数解析、WAL 恢复/重放、帧循环、输出与退出码（导出 `main` 便于进程内测试）
- `src/protocol.js` — 分帧、seq/ack、去重、乱序缓冲
- `src/core.js` — 退款状态机、预算、SLA、审计链（纯函数式，无 I/O）
- `src/wal.js` — CRC32 校验的 WAL，撕裂尾部截断恢复
- `test/` — node:test 测试；`testlib/reference.js` — 独立串行参考实现
- `examples/` — 验收场景输入与配置
