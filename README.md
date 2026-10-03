# 气象观测更正流程（库 + CLI）

观测值只能通过带时间戳、原因码、作者的更正单修改；每条更正保存前像/后像。
纯 JavaScript，仅标准库，测试用 `node:test`。

## 功能

- 增量更正的撤销/重做：撤销只逆置当前游标之前的更正；撤销后新增更正会截断重做分支。
- 连续更正压缩：`compact(startSeq, endSeq)` 把一段连续、未撤销的更正折叠为一条等效更正，
  只折叠前后像，原因码全部保留；压缩前后最终值与状态哈希（SHA-256）不变，
  旧编号到新编号的映射记录在 `idMap` / `compactions` 中。
- 错误（退出码 1）：引用不存在观测（`UNKNOWN_OBSERVATION`）、逆序时间戳
  （`OUT_OF_ORDER_TIMESTAMP`）、压缩区间含已撤销操作（`UNDONE_IN_RANGE`）、
  非法区间（`BAD_RANGE`）。

## 使用

```sh
node cli.js observations.json corrections.json [--state state.json] [--history history.json] [--compact 1:3]
node --test
```

## 文件

- `src/correction-log.js` — 核心库（`CorrectionLog` / `CorrectionError`）
- `cli.js` — 命令行入口（`run()` 可进程内调用，返回退出码）
- `test/correction-log.test.js` — 测试（含 ≤4 条更正的全部撤销/重做序列枚举）
- `observations.json` / `corrections.json` — 示例输入
- `test-result.txt` — `node --test` 的真实输出
