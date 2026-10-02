# 三层对账：渠道流水 / 清算文件 / 银行回单

仅 Node.js 22 标准库 + `node:test`，单机离线，无第三方依赖。

## 命令

```bash
node cli.js reconcile --channel ch.csv --clearing cl.csv --bank bk.csv [--window 300]
node cli.js load      --channel ch.csv --clearing cl.csv --bank bk.csv --state state.json
node cli.js rollback  --batch BCH1 --state state.json [--crash-after-budget 1]
node cli.js budget    --customer C1 --date 2026-10-03 [--limit 1000.00] --state state.json
node --test test/*.test.js
```

CSV 列：`recordId,batchId,parentId,customerId,amount,currency,timestamp,status`
（bank 层 `status=confirmed` 表示银行已确认）。金额内部一律以分为单位的整数运算。

## 机制

- **匹配**：键 = 金额 + 币种 + 时间窗（默认 300s）。支持一对多（子集总额相等，
  优先最小子集）。同额并列匹配全部列入 `candidates`，选字典序最小为 `chosen`。
- **回滚**：`rollback(batchId)` 只回滚该批及其依赖子批（传递闭包）。银行已确认批
  不可回滚，只生成反向调整 `ADJ-<batchId>`，原批状态不变。
- **预算**：客户日净额上限 `limits["customer|date"]`。整批先校验后入账，
  越界则整批失败，禁止部分扣减。
- **崩溃恢复**：回滚分阶段写 journal（`budget_applied` → `done`）。崩溃在更新预算后、
  写回滚标记前，恢复后从 journal 续跑，预算不双扣；`done` 标记保证幂等。

## 错误码

| code | 含义 |
|------|------|
| 20   | 循环依赖 |
| 21   | 孤儿回单（银行回单无父清算批） |
| 22   | 预算越界（整批失败） |

库接口见 `src/index.js`（`parseCsv / reconcile / rollback / dependencyClosure /
checkBudget / loadState / saveState / loadIntoState` 等）。
