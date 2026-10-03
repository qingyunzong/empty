# RESULTS

环境：Node.js v22.22.1，仅标准库，`node --test`（node:test 运行器）。
记录时间：2026-10-03T01:21:24Z（UTC）。

## 全量测试：`node --test`

```
✔ test/cli.test.js    (5/5)
✔ test/fuzz.test.js   (1/1, 40 个随机种子程序对照)
✔ test/lexer.test.js  (3/3)
✔ test/parser.test.js (4/4)
✔ test/types.test.js  (6/6)
✔ test/vm.test.js     (10/10)

tests 6 (files) / 29 (cases)
pass  6 / 29
fail  0
```

真实运行输出（`node --test` 汇总）：

```
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## 验收场景覆盖

1. **拆股后撤销再重述** — `test/vm.test.js` "split -> reverse -> restate keeps full history"：
   100 股 → 拆股 1/2 得 200 → 冲正（生成 `S1#rev1` 反向行动）回到 100 → 重述 v2（1/4）得 400。
   账簿条目序列 `[APPLY, REVERSE, RESTATED, APPLY]`，原始 APPLY 条目保留，历史未删除。
2. **卖出部分 lot 后冲正边界** — `test/vm.test.js` "reverse after partial sell books payable"：
   100 → 200，卖出 150 后冲正，FIFO 回溯仅能收回 50，不足 50 记应付（receivable `-50`），持仓不为负。
3. **非法比例与现金混用** — `test/types.test.js`：`ratio 2` / `ratio 1` / 负比例 → `E_RATIO`；
   `$2.5 + 3sh`、`$2.5 * $2`、cash 字段给无量纲值 → `E_TYPE`；比例给现金类型 → `E_RATIO`。
4. **随机对照** — `test/fuzz.test.js`：40 个种子 × 每程序 25–40 个随机操作
   （拆股/分红/卖出/冲正，3 证券、随机 lot），VM 结果与测试内独立实现的
   FIFO 参考模型逐 lot、现金、应收应付全等。

## CLI 冒烟（真实输出）

`node bin/corp.js apply examples/actions.ca examples/lots.json --ledger`：

```
== Ledger ==
APPLY S1 split AAPL v1 ex=2024-06-10 #cf7f0cbe cash=0
APPLY D1 dividend AAPL v2 ex=2024-06-10 #332593e8 cash=800
APPLY T1 tender MSFT v1 ex=2024-08-01 #9ba44219 cash=15400
SELL AAPL 150 on 2024-06-20 (L1:150)
REVERSE S1#rev1 inverse-of=S1 split AAPL v1 cash=0
RECEIVABLE AAPL -50 (reverse of S1)
RESTATED S1 AAPL v1 -> v2
APPLY S1 split AAPL v2 ex=2024-06-10 #f1645606 cash=0
== Positions ==
AAPL L2 240 acquired=2024-03-11
== Cash ==
17200
== Receivables ==
AAPL -50 (reverse of S1)
```

错误路径：`corp apply` 遇 `E_RATIO` / `E_LOT` 等打印 `E_XXX: message` 到 stderr 并以退出码 1 终止（用法错误为 2），见 `test/cli.test.js`。
