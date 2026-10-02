# 净额结算优化器（组17）

财务把多笔应收应付合成净额结算方案，在手续费、到账时效、冻结占用三约束下
选最优方案；同成本并列方案全部枚举并可审计。仅 Node.js 22 标准库 + node:test。

## 数据模型

- `obligations.json`: `{ obligations: [{ id, from, to, amount, days, status }] }`
  - `amount` 为正整数（最小货币单位）;`status` 为 `confirmed` 或 `pending`。
- `constraints.json`: `{ fee_bps, fixed_fee, freeze_bps, max_total_fee, max_days, max_total_freeze, max_daily_amount }`
  - 每笔净额支付：`fee = fixed_fee + amount*fee_bps/10000`（向下取整）,
    `freeze = amount*freeze_bps/10000`,`days` 取组内最大。

## 机制

- 同一对手方对的所有义务按代数和净额；净额方向即和的符号，任一方的最终
  应收应付符号不变（逐方头寸严格相等，emit 前强制校验）。
- 预算约束：`fee <= max_total_fee`、`days <= max_days`、
  `freeze <= max_total_freeze`、`amount <= max_daily_amount` 同时满足；
  任一越界整案失败，无部分扣款。
- 目标序：结算本金最大 → 手续费最小 → 冻结最小 → 时效最小。
  同成本并列方案全部枚举进证书（`tiedKeys` + `candidateSetHash`)，
  执行方案按固定键序（字典序最小）选出。
- 执行标记最后写入（临时文件 + rename)；标记缺失即未执行，可安全重选。
  已执行方案不可 rollback（exit 72)，只能 `rollback --reverse` 生成反向方案。

## 命令

```
node cli.js optimize [--obligations f] [--constraints f] [--out plan.json] [--exclude-pending]
node cli.js emit [--plan f] [--state dir]
node cli.js rollback [--plan f] [--state dir] [--reverse]
node cli.js explain [--plan f] [--subset o1,o2]
node --test test/*.test.js
```

退出码：`70` 不可行；`71` 把未决（pending）当不可满足；`72` 执行后回滚。

## 测试与结果

`node --test test/*.test.js` 覆盖四条验收：n≤14 暴力枚举对照、越界整案失败、
崩溃恢复安全重选、并列最优证书候选集哈希。真实输出见 `RESULTS.md`。
