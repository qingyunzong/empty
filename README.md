# rework-station

包装线印刷缺陷返工台决策引擎：对每件缺陷品判定 **返工 / 报废 / 让步接收**，
并生成可供财务与质量同时复核的决策流与守恒台账。仅 Node.js 22 标准库，
单机离线，测试使用 `node:test`。

## 运行

```sh
node cli.js run --defects defects.jsonl --policy policy.json --stock stock.json [--outdir .]
node cli.js audit --policy policy.json --stock stock.json --ledger ledger.jsonl
node cli.js counterexample --defects defects.jsonl --policy policy.json --stock stock.json --decision decision.jsonl
node --test   # 运行全部测试
```

## 输入

- `policy.json`：`currency`、`shiftBudget`（班次预算）、`stockUseCap`（班次库存消耗上限）、
  `concessionThreshold`（让步金额阈值）、`categories`（类目 → 默认缺陷等级与返工成本）、
  `reworkableLevels`、`blacklist`（客户黑名单）。
- `stock.json`：`{ "PRODUCT": 数量 }`，任一数量为负 → exit 19。
- `defects.jsonl`：按行三种记录：
  - 缺陷：`{"id","product","customer","amount","level"?,"reworkCost"?}`，
    `level` 缺省时继承产品类目等级；重复缺陷号 → exit 21。
  - 撤销：`{"type":"cancel","defectId","reason"?}`，回补库存但**不**自动回补预算。
  - 预算更正：`{"type":"budgetCorrection","amount","currency"?,"reason"?}`，
    显式回补/扣减预算；币种未知 → exit 20。

## 核心语义

- **返工授权**受双重约束：班次预算（返工成本合计 ≤ `shiftBudget`）与库存
  （总消耗 ≤ `stockUseCap` 且单产品 ≤ 库存）。在约束内选择总节省
  （`amount - reworkCost`）最大的返工子集；节省相同并列时按成本升序、
  再按缺陷号字典序确定性选择。候选 ≤20 时用位掩码枚举精确求解，否则贪心。
- **让步 vs 报废**冲突：客户黑名单优先（直接报废）；其次金额阈值
  （低于阈值让步、高于报废）；金额等于阈值为平级 → 拒绝让步（报废）。
- **撤销返工**回补库存，预算不自动回补，须显式 `budgetCorrection` 事件。
- **审计**：`audit` 从初始状态重放 `ledger.jsonl`，校验序列连续、
  账户不为负、撤销不动预算、预算只经返工决策或显式更正变动，
  并校验末条 `final` 守恒条目与重放终态一致。
- **反例**：`counterexample` 对一份（可能超预算的）返工方案给出违反的约束，
  以及使其通过所需的**最少缺失约束**集合（`budget` / `stockUseCap` / `perProductStock`）。

## 输出

- `decision.jsonl`：每缺陷一行，含继承后的 `level`、`action`、`rule`
  （决策依据，供质量复核）、`reworkCost`/`savings`（供财务复核）、`cancelled` 标记。
- `ledger.jsonl`：每输入行一条台账事件（`decision`/`cancel`/`budgetCorrection`），
  含 `stockDelta`、`budgetDelta` 与事件后 `balances`，末条为 `final` 守恒条目。

## 退出码

- `19` 库存为负；`20` 预算币种未知；`21` 重复缺陷号；`1` 其他校验错误；`2` 用法错误。
