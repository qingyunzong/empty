# 气象观测更正流程

观测值只能通过带时间戳、原因码和作者的更正单修改。每条更正保存前像（`before`）与后像（`after`）。

## 库（`src/correction-log.js`）

- `new CorrectionLog(observations)`：`observations` 为 `[{ id, value }]`。
- `apply(correction)`：应用 `{ id, observationId, timestamp, reason, author, newValue }`；撤销后新增会更正会截断重做分支。
- `undo()` / `redo()`：只逆置/重放当前游标处的更正。
- `compress(start, end)`：把连续区间折叠为一条等效更正（前像取首条、后像取末条），原因码全部保留在 `reasons`，原始编号保留在 `compressedFrom`；最终值、审计编号映射与状态哈希不变。
- `getState()` / `stateHash()` / `getHistory()` / `auditMap()`。

错误以 `CorrectionError` 抛出，`code` 包括 `UNKNOWN_OBSERVATION`、`OUT_OF_ORDER_TIMESTAMP`、`COMPRESS_RANGE_CONTAINS_UNDONE`、`INVALID_COMPRESS_RANGE`、`COMPRESS_RANGE_MIXED_OBSERVATIONS`。

## CLI

```sh
node cli.js observations.json corrections.json [outDir]
```

输出 `state.json`（最终值 + `stateHash`）与 `history.json`（更正条目、游标、审计编号映射）。任何数据错误以退出码 1 终止。

## 测试

```sh
node --test
```
