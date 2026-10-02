# recon — 三方对账（bank / core / adj）

单机离线，Node.js 22，仅标准库。

## 用法

```
recon <bank.jsonl> <core.jsonl> <adj.jsonl> --out entries.jsonl --conflicts c.json [--tol 0.01]
```

- 输入为 JSONL，每行一条记录。
- bank/core 必填 `valueDate, account, ccy, amount`，可选 `explicitId`。
- adj 必填 `amount`，并用 `link`（explicitId 或 `valueDate|account|ccy|amount`）、
  `explicitId` 或自身 `valueDate/account/ccy` 归组。
- 分组键：`explicitId` 优先，否则 `(valueDate, account, ccy)`；金额在组内按容差多重集匹配。

## 规则

- `MISSING_CORE`：bank 有、core 无。
- `UNSETTLED`：core 有、bank 无。
- `ADJ_CONFLICT`：adj 金额与任一侧冲突（超出容差）。
- `THREE_WAY`：同 explicitId 且三方各一条、金额两两不同。
- 容差 `tol` 内可匹配，差异记入 `rounding`；组内挂了 adj 时，三方一致才入账。
- 同键多笔按金额多重集最大匹配；并列取日期/id 字典序。
  组内 max(|bank|,|core|) <= 7 时用独立笛卡尔枚举验证匹配数最大且结果确定。

## 输出

- `entries.jsonl`：仅确定项，含 `rounding.core` / `rounding.adj`。
- `c.json`：冲突数组，每条含 `rule`、三方规范哈希 `hash`
  （对 `{key, bank[], core[], adj[]}` 规范化金额的 sha256）及两侧记录 id。

## 退出码

- `0` 正常；`2` 用法/输入格式错误
- `18` 重复 explicitId；`19` 负容差；`20` adj link 悬空

## 测试

```
node --test
```
