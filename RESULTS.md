# RESULTS — 真实运行结果

环境：Node.js v22.22.1，仅标准库 + `node:test`，单机离线。运行时间 2026-10-03 (Asia/Shanghai)。

## 测试套件：`node --test test/*.test.js`

```
# tests 4
# pass 4
# fail 0
```

逐文件（`node <file>` 展开的子测试，全部通过，共 24 个）：

- `test/reconcile.test.js` — 8 通过：CSV 引号解析、一对一匹配、时间窗外不匹配、
  币种不匹配、一对多求和匹配、**验收4** 同额并列全部列出且选字典序最小、
  一对多并列子集字典序最小、孤儿回单 code=21。
- `test/rollback.test.js` — 7 通过：**验收1** 100 批嵌套依赖、每个根节点的依赖闭包
  与暴力枚举（不动点扫描）逐一相等（含 n≤9 的闭包）、回滚精确标记闭包、
  **验收2** 已确认银行批生成反向调整且原批状态不变、闭包内确认批分层处理、
  循环依赖 code=20、孤儿回单 code=21、回滚幂等。
- `test/budget.test.js` — 3 通过：预算越界 code=22 整批失败零扣减、
  恰好等于上限可通过、**验收3** 崩溃在更新预算后未写回滚标记，
  恢复后续跑预算不双扣（净额保持 -10000 分，journal 进入 done，再次回滚为 no-op）。
- `test/cli.test.js` — 6 通过：reconcile/load/rollback/budget 端到端、
  退出码 20/21/22、崩溃恢复 CLI 流程。

## CLI 实测（样例数据见 `data/*.csv`）

`node cli.js reconcile --channel data/channel.csv --clearing data/clearing.csv --bank data/bank.csv`
→ 3 条 matched：CL1↔CH1（一对一）、CL2↔CH2+CH3（一对多，总额 100.00）、
BK1↔CL1+CL2（跨层一对多）；BK2 因清算记录已占用成为孤儿回单（code=21）。

`node cli.js load ... --state data/state.json` → `{"added":4,"updated":0,"total":4}`

`node cli.js rollback --batch BCH1 --state data/state.json`（限额 1000.00）→
`rolledBack: [BCH1, BCL1, BBK2]`，`reversals: [ADJ-BBK1]`（BBK1 银行已确认，
原批状态保持 active）；`budget` 显示 `net: -80000`（分），未越界。

预算越界（限额 100.00，新状态）：`node cli.js rollback --batch BCH1` →
退出码 **22**，`{"code":22,"error":"budget exceeded: whole batch rejected, no partial deduction",...}`，
全部批次保持 `active`，`budgets: {}` 零扣减。

崩溃恢复：`node cli.js rollback --batch BCL1 --crash-after-budget 1` → 退出码 1
（模拟崩溃，journal=budget_applied 已落盘）；再次 `rollback --batch BCL1` →
`resumed: true`，净额 -60000 分（BCL1+BBK1+BBK2 各 200.00，仅扣一次）。
