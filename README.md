# fill-cancel-join

按事件时间把撤单流联接到成交流：10 秒窗口、双侧水位线、部分撤单、
孤儿撤单与 late-join 报告，输出每 symbol 的日终可成交金额。
仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 用法

```sh
node cli.js join --trades t.jsonl --cancels c.jsonl --out o.jsonl \
  [--summary s.json] [--orphans orphans.jsonl] [--late late.jsonl]
node --test
```

输入为 JSONL，每行 `{orderId, symbol, qty, price, ts}`（`ts` 毫秒）。

## 退出码

- `0`：成功（业务孤儿不失败）
- `2`：存在行错误（缺字段、`qty<=0`、价格非分整数、非法 JSON），
  错误行被跳过，结果文件照常写出
- `64`：用法错误；`1`：IO 错误

## 语义约定

- 联结键 `(orderId, symbol)`；窗口 `win = floor(ts / 10000)`。
- 水位线取各自流的最大 `ts`；窗口 `w` 在双侧水位线都越过它后关闭
  （`w < min(win(tradeWm), win(cancelWm))`）。
- cancel 按 `(ts, 行号)` 顺序扣减同键 trade（先到期先扣），可全部或
  部分撤回；`cancel.ts < trade.ts` 但同一逻辑窗仍可匹配，也可匹配
  更晚窗口的 trade（匹配窗取两侧较大者）。
- 匹配窗已关闭的匹配输出为 late-join：单独列出，不改已发布窗、
  不计入汇总。
- 同一 cancel（内容完全相同）重复到达只生效一次。
- 无对应 trade 的 cancel、以及超过可撤总量的部分，列为孤儿撤单，
  不产生负成交。
- `fills.jsonl` 含 `{orderId, symbol, qty, win, proof}`：既包含撤单
  匹配的联接证据，也包含各 trade 窗口的剩余可结算量；`proof` 为
  贡献行号（`trades:N` / `cancels:M`）的 SHA-256 默克尔根。
- 每 symbol 汇总（`--summary`）只统计未被撤回的剩余量，即可成交金额。

## 库接口

```js
const { joinStreams } = require('./lib/join');
const { fills, orphanCancels, lateJoins, symbols, errors } =
  joinStreams(tradesText, cancelsText);
```
