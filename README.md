# rework-line

包装线返工台决策引擎：对印刷缺陷品判定 **返工 / 报废 / 让步接收**，并生成可供财务与质量双方复核的台账。Node.js 22，仅标准库，单机离线。

## 运行

```sh
node src/cli.js run --defects defects.jsonl --policy policy.json --stock stock.json \
    --decisions decision.jsonl --ledger ledger.jsonl
node src/cli.js audit --policy policy.json --stock stock.json --ledger ledger.jsonl \
    [--checks a,b,c] [--counterexample]
node --test   # 全部测试
```

退出码：`19` 库存为负；`20` 预算币种未知（不在 `policy.currencies` 内，或返工成本币种与预算币种不一致）；`21` 缺陷号重复；`1` 其他输入错误；`2` 用法错误。

## 输入

- `policy.json`：`currencies`（已知币种表）、`categories`（类目 → 严重等级）、`rework.{allowedSeverities, costPerUnit, shiftBudget}`、`concession.{amountThreshold, blacklist}`。
- `stock.json`：`items[] = {sku, category, onHand}`，`onHand < 0` → exit 19。
- `defects.jsonl`：事件流。
  - `{"type":"defect","id","sku","customer","amount"}`（`type` 可省略）；`id` 重复 → exit 21。
  - `{"type":"cancel_rework","defectId","reason"?}`：撤销返工。
  - `{"type":"budget_correction","amount","reason"?}`：显式预算更正。

## 核心语义

1. **等级继承**：缺陷严重等级继承自 sku 所属产品类目（`stock.json` 的 `category` → `policy.categories`），未知 sku 回落到 `defaultSeverity`。
2. **返工授权双重约束**：仅 `allowedSeverities` 等级可返工；每次返工消耗 1 件该 sku 库存与 `costPerUnit` 班次预算。在库存上限与班次预算双重约束下，精确求解（分支限界）使挽回净值 `Σ(amount − cost)` 最大的返工子集；**同额并列最优按排序后 id 元组字典序最小者确定性选择**。≤20 缺陷时与朴素枚举对照（test D）。
3. **让步接收 vs 报废冲突**：客户黑名单优先（→ 报废）；其次金额阈值：`amount < threshold` → 让步接收，`>` → 报废，`==` 为平级 → 拒绝让步（→ 报废）。
4. **撤销返工**：回补库存（`stockDelta +1`），但**预算不自动回补**（`budgetDelta 0`）；只有显式 `budget_correction` 事件才回补预算。
5. **审计与守恒**：`audit` 从初始库存/预算重放台账，校验六类约束——`init_conservation`、`step_conservation`（守恒）、`budget_non_negative`、`stock_non_negative`、`cancel_requires_rework`、`budget_increase_only_via_correction`。`--counterexample`：当台账在弱化检查集下仍通过时，给出能使其被拦截的**最少缺失约束**（每个返回项单独即充分）。例：超预算台账在仅守恒检查下通过，反例指出缺失 `budget_non_negative`。

## 输出

- `decision.jsonl`：每个缺陷一行 `{id, sku, category, severity, action, reason, amount}`，`action ∈ {rework, scrap, concession}`。
- `ledger.jsonl`：`seq:0` 为 `init`；随后每个缺陷一条（`rework_authorized` / `concession_accepted` / `scrapped`），再按文件顺序应用 `rework_canceled` / `budget_correction`；每行携带 `stockDelta`、`budgetDelta` 与完整 `stockAfter`、`budgetAfter` 快照，供守恒重放。

## 批次语义

所有 `defect` 事件作为一个班次批次统一决策（优化器在整批上分配稀缺的预算与库存）；`cancel_rework` 与 `budget_correction` 事件在批次决策之后按文件顺序应用。精确求解器最坏情况为指数级（候选数 ≤ 20 时与朴素枚举等价的规模可秒级完成）。

## 结构

- `src/model.js`：输入解析与校验（退出码 19/20/21）、等级继承。
- `src/optimize.js`：`selectRework`（分支限界，生产路径）与 `selectReworkNaive`（朴素枚举，对照用）。
- `src/decide.js`：批次决策与台账生成。
- `src/audit.js`：守恒审计与最少缺失约束反例。
- `src/cli.js`：`run` / `audit` 命令。
