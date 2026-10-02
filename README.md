# margin-freeze-ledger

保证金冻结合并库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 模型

- 状态按证券维护：可用保证金、冻结列表、释放墓碑（tombstone）。
- 冻结事件：`{"eventId","freezeId","symbol","amount"}`；释放事件：`{"eventId","freezeId","amount"}`，可部分释放，累计释放不得超过冻结金额。
- 事件日志溯源：合并 = 事件日志并集 + 初始保证金并集，按 eventId 排序确定性重放。
  多副本并发冻结同一证券，合并后冻结额相加、可用额相应减少。
- 冻结被全部释放后保留墓碑：相同 eventId 的重复释放为幂等空操作；
  新 eventId 的陈旧释放返回 `over-release`，冻结不会复活。
- 事件幂等：完全相同的事件 ID + 载荷为空操作；同 ID 不同载荷返回 `event-conflict`。
- 证书包含证券、可用额、冻结列表与释放哈希（每条墓碑的 sha256 及整体 `releaseHash`）。

## CLI

```sh
node margin.js init <file> <symbol> <amount>        # 初始化/设定保证金
node margin.js freeze <file> <json|@file|->         # 冻结
node margin.js release <file> <json|@file|->        # 释放（可部分）
node margin.js merge <fileA> <fileB> [outFile]      # 合并 B 进 A（或写入 outFile）
node margin.js position <file> <symbol>             # 查询头寸
node margin.js cert <file> <symbol>                 # 输出证书
```

JSON 输入输出；错误输出 `{"error":"code"}` 并以退出码 1 结束。
错误码：`insufficient-margin`、`over-release`、`unknown-freeze`、`event-conflict`、
`duplicate-freeze`、`margin-conflict`、`invalid-event`、`invalid-amount`、`invalid-json`、`usage`。

## 测试

```sh
node --test --test-reporter spec > result.txt 2>&1; echo $? >> result.txt
```
