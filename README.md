# recon — 日终对账 CLI

Node.js 22，仅标准库。测试：`node --test`。

## 用法

```
node bin/recon.js --dir <d> --out <r.json> [--explain plan.txt] [--no-index]
```

读取 `<d>/internal.csv`、`bank.csv`、`fee.csv`，输出对账结果 JSON 与执行计划。

## CSV 模式（表头必需）

- `internal.csv`: `date,account,txn_id,currency,amount,fee`
- `bank.csv`:     `date,account,txn_id,currency,amount`
- `fee.csv`:      `date,account,txn_id,currency,fee`

`amount`/`fee` 留空表示 SQL NULL。

## 核心语义

- 键 = `(date, account, txn_id)`；匹配用关系代数表达：`matched = internal ⋈ bank`，
  `onlyInternal = internal ▷ bank`，`onlyBank = bank ▷ internal`（差集/反半连接）。
- NULL 语义：NULL 不等于任何值（包括 NULL）。金额/手续费任一侧为 NULL 的键
  不进入 `matched`，而是进入 `amountDiff`/`feeDiff`，并带 `isNull`
  标志（`left`/`right`/`both`）。
- 聚合：`summaryByCurrency` 按币种汇总差异（diffCount、sumAbsDiff、avgAbsDiff），
  avg 忽略 NULL（两侧均非 NULL 才计入）。
- 同一源内键重复 → `E_AMBIGUOUS`；表头/类型非法 → `E_SCHEMA`。
  错误时 stderr 输出 `{"code","message"}`，exit code != 0。

## 查询优化

- 默认对连接键建哈希索引（hash join，build 侧选较小关系）；`--no-index`
  退化为嵌套循环连接。
- `--explain` 输出连接顺序与理由；连接可交换且输出按键排序，结果与顺序无关
  （测试 B 验证索引开/关结果一致、计划不同）。
