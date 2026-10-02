# 商户退款风控服务（refund-risk-service）

Node.js 22，仅标准库，`node:test`，单机离线。客户端以 JSON 行帧（JSONL）发送
`payment / refund / approve / reject / expire / reverse` 请求，服务端完成协议层的
重传去重、乱序重组、分帧解析与虚拟时钟 SLA 超时，以及业务核心的退款幂等、风险预算与撤销恢复。

## 运行

```bash
node cli.js <ops.jsonl>          # 处理操作流，stdout 输出报告
node --test                      # 运行全部测试
```

环境变量：

- `REFUND_WAL`：WAL 文件路径，默认 `<ops.jsonl>.wal`。
- `REFUND_REPLAY=1`：启动时重放已有 WAL（默认每次运行截断重来）。

退出码：`0` 正常；`2` 帧错（非法 JSON / 未知类型 / 字段校验失败）；`3` 冲突
（同 key 金额或订单不同）；`4` 超限（退款超过原支付可退余额 / 未知订单）。
冲突与超限同时出现时以冲突（3）为准。

## 帧格式

每行一个 JSON 对象。公共字段：`type`、`seq`（正整数，全局递增）、`ts`
（虚拟时钟毫秒，缺省 0）、`ack`（可选，客户端已确认的最大 seq，用于回收响应缓存）。

| type      | 必填字段                              | 语义                     |
|-----------|---------------------------------------|--------------------------|
| payment   | order, amount                         | 建立原支付（可退余额）   |
| refund    | key, order, amount, riskTag           | 退款申请                 |
| approve   | key                                   | 批准退款                 |
| reject    | key (reason 可选)                     | 拒绝退款                 |
| expire    | key                                   | 主动过期                 |
| reverse   | key                                   | 撤销已 approve 的退款    |

## 协议层（src/protocol.js）

- **分帧**：按行解析，任何非法行立即以退出码 2 终止。
- **重传去重**：`seq < nextSeq` 的帧判定为重传，返回缓存的原始响应，不重复执行；
  `ack` 用于回收已确认的响应缓存。
- **乱序重组**：`seq` 跳跃的帧进入缓冲区，按序交付；文件结束时缓冲帧按 seq 升序
  补投递（标记 `gap`）。因此输入行的任意排列都产生相同结果（验收 5 的性质）。

## 业务核心（src/engine.js）

- **幂等**：同 key 同金额同订单的 refund 返回原结果，不改状态；同 key 金额/订单不同
  记为冲突（exit 3）。
- **可退余额**：退款受理时占用 `order.reserved`，approve 转为 `refunded`，
  reject/expire 释放；申请额超过 `paid - refunded - reserved` 即拒绝
  （`OVER_LIMIT`，exit 4）。
- **风险预算**：`riskTag: "high"` 的退款占用滚动预算（窗口 60s，上限 1000，
  见 `src/config.js`）。受理时预留（reserved），approve 时转为实扣（deducted），
  reject/expire 释放预留，reverse 释放实扣。预算不足进入队列（QUEUED），
  预算释放或窗口滚动后按 **(申请时间, key)** 顺序准入——同刻并列按 key 决胜。
- **SLA**：虚拟时钟取帧 `ts` 的单调最大值；PENDING/QUEUED 超过
  `受理时间 + 30s` 未决策即自动过期（`SLA_EXPIRED`），到点自动拒绝。
- **迟到决策**：对已终止（EXPIRED/REJECTED/REVERSED）的 key 的 approve/reject/expire
  返回 `late` + `ALREADY_*`，不改变状态。approve/reject/expire 先于 refund 到达时
  记录为待决决策，refund 受理时立即应用。
- **撤销恢复**：reverse 生成 `reverseRefund:<key>` 条目，回补预算与可退余额；
  历史不可改——APPROVED 记录保留，仅追加 REVERSED。

## WAL 与故障恢复（src/wal.js）

每次状态迁移先写 WAL（JSON 行，含单调 `lsn`）再响应。故障点定义为
**决策前（beforeDecision）、日志后（afterLog）、响应前（beforeResponse）**，
引擎提供同名 hook 供测试注入崩溃。重启后重放 WAL 折叠状态，所有操作幂等，
重放不得二次扣减（test/recovery.test.js 对 3 个故障点 × 3 个崩溃位置逐一验证）。

审计 hash 为 WAL 的哈希链：`hash = sha256(prevHash + '\n' + jsonl行)`，
重启重放后与干净运行完全一致。

## 输出

stdout 输出 JSON 报告：每 key 状态（`keys`）、订单可退余额（`orders`）、
预算占用（`budget`）、拒绝码（`rejections`）、错误（`errors`）、
审计 hash（`auditHash`）及逐帧响应（`responses`）。

## 真实输出记录

`node cli.js examples/demo.jsonl`（demo 覆盖排队、撤销回补、重复 refund、超限）：

```json
{
  "keys": {
    "r1": { "state": "REVERSED", "order": "o1", "amount": 700, "riskTag": "high" },
    "r2": { "state": "APPROVED", "order": "o1", "amount": 500, "riskTag": "high" },
    "r3": { "state": "REJECTED", "order": "o2", "amount": 400, "riskTag": "high", "code": "MANUAL_REJECT" },
    "r4": { "state": "REJECTED", "order": "o2", "amount": 600, "riskTag": "low", "code": "OVER_LIMIT" }
  },
  "orders": {
    "o1": { "paid": 2000, "refunded": 500, "reserved": 0, "refundable": 1500 },
    "o2": { "paid": 500, "refunded": 0, "reserved": 0, "refundable": 500 }
  },
  "budget": { "limit": 1000, "windowMs": 60000, "used": 500, "reserved": 0, "deducted": 500 },
  "rejections": [
    { "key": "r3", "code": "MANUAL_REJECT", "ts": 700 },
    { "key": "r4", "code": "OVER_LIMIT", "ts": 900 }
  ],
  "errors": [ { "type": "over_limit", "key": "r4", "code": "OVER_LIMIT" } ],
  "auditHash": "640ffa937246f64c0404fbea918229af1e62706faad6f6cd8b4d8f5a796f8588",
  "clock": 900
}
```

退出码 `4`（r4 超限）。完整输出含 `responses` 逐帧响应，可从
`node cli.js examples/demo.jsonl` 复现。

各验收场景示例（examples/ex1..ex5）真实结果摘要：

| 场景 | 关键结果 | auditHash |
|------|----------|-----------|
| ex1 重复 refund | k1 APPROVED，预算只扣一次（used=100） | 17605695…b86b16 |
| ex2 乱序 approve | 协议按 seq 重排，k1 APPROVED | 5a28cde4…d0203d |
| ex3 预算同刻决胜 | ka REVERSED，kb APPROVED，kc SLA_EXPIRED | 52a3cc46…c50c4a6e |
| ex4 expire+迟到 approve | k1 EXPIRED / k2 SLA_EXPIRED，迟到 approve 无效 | 068b76e7…bfa57aed |
| ex5 六请求基准 | k1 REVERSED，k2 REJECTED | e3184af3…f42e2a |

`node --test` 真实输出：

```
# tests 4
# pass 4
# fail 0
```

（4 个测试文件共 23 个用例：acceptance 7、recovery 10、cli 4、protocol 2，全部通过。）

## 目录结构

```
cli.js            # CLI 入口（可导入 runCli 供测试）
src/config.js     # SLA / 预算窗口 / 预算上限 / 高风险 tag
src/protocol.js   # 分帧、重传去重、乱序重组、ack 缓存回收
src/engine.js     # 业务核心：幂等、预算、SLA、撤销、故障 hook
src/wal.js        # WAL 追加/重放 + 审计哈希链
src/runner.js     # 协议+引擎装配，退出码判定
test/             # acceptance / recovery / cli 测试
examples/         # demo 与 5 个验收场景操作流
```
