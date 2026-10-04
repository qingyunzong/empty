# restatement-engine

离线监管报表重述库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 用法

```
node . restate input.json output.json
node --test
```

## 输入（input.json）

- `items`: 报表项目，`{ id, side, restatement }`。`side` 决定借贷方向（asset/expense 为借方性质，liability/equity/revenue 为贷方性质）；`restatement: true` 的项目才允许在关闭期间入账。
- `periods`: 期间，`{ id, status: "open" | "closed" }`。
- `balances`: 各项目在各期间的当前余额。
- `domain`: 分录金额域，`{ min, max, step }` 或 `{ values: [...] }`（0 隐式可用，表示不入账）。
- `formulas`: 勾稽公式，`{ id, lhs, rhs }`，项为 `{ item }` / `{ side }` / `{ const }`，可加 `coef`。公式须在每个期间配平（如资产和 = 负债 + 权益）。
- `check`: 可选，需配平的公式 id 子集；引用不存在的公式退出码 1。
- `vouchers`: 凭证，`{ id, layer, required }`。同一凭证借贷必须配对（按项目性质加权和为 0）。
- `layers`: 发布层，按数组顺序自下而上发布，`publish: "ok" | "fail"`。
- `budget`: 回溯预算，超出为 `PENDING`；枚举证明无解才是 `UNSAT`。

## 输出（output.json）

- `status`: `SOLVED` / `UNSAT` / `PENDING`。
- `selection`: 更正分录（凭证、项目、期间、金额）。
- `targetPeriods` / `periods`: 目标期间与期间状态。
- `layers` / `reversalTotal`: 分层状态（PUBLISHED / FAILED / ROLLED_BACK）与冲回额——下层发布失败后上层预留冲回。
- `conflicts`: 最小公式冲突核（UNSAT 时给出，PENDING 为 null）。
- `residuals` / `balanced`: 更正后各公式各期间残差。

引用不存在的公式或非法期间时退出码为 1，并写出 `{ status: "ERROR" }`。

## 结构

- `lib/model.js` — 输入校验、公式求值。
- `lib/solver.js` — 域传播 + 回溯 + 回溯预算 + 最小冲突核。
- `lib/publish.js` — 逐层发布与回滚模拟。
- `lib/brute.js` — 小规模枚举对照（≤3 项目 2 期间）。
- `test/` — 验收：三表配平、关闭期间重述、层叠回滚、UNSAT、枚举对照、CLI 退出码。
