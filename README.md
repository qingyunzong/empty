# restate — 监管报表重述求解器

离线库 + CLI。为更正分录选择报表项目与目标期间，使勾稽公式重新配平，并模拟逐层发布与回滚。仅使用 Node.js 22 标准库与 `node:test`。

## 用法

```sh
node . restate input.json output.json
node --test
```

退出码：输入非法（引用不存在的公式、目标期间非法、结构错误等）为 1；求解完成（含 OK / ROLLED_BACK / UNSAT / PENDING）为 0。

## 输入

```json
{
  "items":      [{ "id": "cash", "side": "asset|liability|equity", "domain": [lo, hi], "restatement": false }],
  "balances":   { "cash": 100 },
  "periods":    [{ "id": "2024Q4", "status": "open|closed" }],
  "formulas":   [{ "id": "bs", "lhs": ["cash"], "rhs": ["equity"], "constant": 0 }],
  "layers":     [{ "id": "L1", "formulas": ["bs"], "reserve": 100, "maxAmount": null }],
  "constraints":{ "period": "2024Q4", "formulas": ["bs"] },
  "budget":     100000
}
```

- `domain`：该项目可承受的更正金额整数区间；不含 0 表示该项目必须被动用。
- 勾稽公式：`sum(lhs 余额) - sum(rhs 余额) = constant`（默认 0），对更正后的余额成立。
- `layers`：数组顺序即由低到高的发布顺序；`reserve` 为该层预留额，`maxAmount` 为该层允许的更正总额上限。
- `constraints`：可选，强制目标期间或指定需配平的公式子集。

## 语义

- **凭证配对**：同一更正凭证内全部金额之和为 0（借贷配对），且至少一条非零分录。
- **关闭期间**：只能使用 `restatement: true` 的重述项目。
- **求解**：整数域传播（区间一致性）+ 回溯；`budget` 为回溯节点预算，到顶返回 `PENDING`，只有完整枚举证明无解才返回 `UNSAT`。
- **冲突解释**：UNSAT 时输出删除式最小化的不可满足公式子集（最小公式冲突）及各公式可达区间。
- **分层发布**：自低层向高层逐层校验（公式配平 + 层上限）；低层 FAILED 时，所有更高层的预留额被冲回（`reversal = reserve`，状态 `ROLLED_BACK`），下层保持 `PUBLISHED`。

## 输出

`status`（OK / ROLLED_BACK / UNSAT / PENDING）、`period`、`items`（项目选择）、`entry`（分录与借贷合计）、`layers`（分层状态与冲回额）、`reversals`（总冲回额）、`conflict`（最小公式冲突与解释）、`nodes`/`backtracks`/`budget`。

示例见 `examples/restate.json`。
