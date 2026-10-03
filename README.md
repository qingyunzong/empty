# 设备状态日历库及 CLI

Node.js 22，仅标准库与 `node:test`，离线单机执行。

## 模型

- **区间**：一律左闭右开 `[start, end)`，UTC 毫秒。
- **时区表**：显式提供转换表 `{ 时区名: [{ startUtcMs, offsetMinutes }] }`，
  本地→UTC 取“本地生效起点 ≤ 本地时间的最大条目”（回拨歧义确定性地取后一条目）。
- **日历**：
  - `shifts` 周期班次：本地锚点 `anchorLocalMs` + `periodMs` 周期 + `durationMs` 绝对时长，
    可跨偏移切换夜（UTC 起点随表迁移，时长不变）；
  - `exceptions` 停产例外：从班次/交接区间中减去；
  - `handovers` 半时区交接区间：起点、终点分别按各自时区表换算。
- **命令**：`occupy`（占用）/ `release`（释放）/ `override`（状态覆盖），
  各带 `baseVersion`。仅当相交区间由 `version > baseVersion` 的命令写入时拒绝 `REVISION`，
  并输出冲突证书 `{ commandId, conflictWith, firstOverlapMs }`（双方命令 ID + 首个重叠毫秒）。
- **事务**：`begin`/`commit`/`abort`/`savepoint`/`rollback`，可嵌套。
  内层失败只回滚内层已写区间；内层 `commit` 后写入并入外层（层级回滚）；
  外层回滚到保存点即部分保留保存点前的写入；流末尾未闭合事务自动回滚。
- **错误**：`ZERO_PERIOD`（零时长周期）、`INTERVAL_INVERSION`（区间反转）、
  `UNKNOWN_SAVEPOINT`（未知保存点，当前事务失败回滚，外层可继续）。

## 输入 / 输出

```jsonc
// 输入
{
  "timezones": { "T": [{ "startUtcMs": 0, "offsetMinutes": 480 }] },
  "calendar": { "shifts": [], "exceptions": [], "handovers": [] },
  "calendarWindow": { "fromUtcMs": 0, "toUtcMs": 172800000 },
  "stream": [
    { "type": "begin", "tx": "t1" },
    { "type": "occupy", "id": "c1", "resource": "dev1",
      "startMs": 0, "endMs": 1000, "baseVersion": 0 },
    { "type": "savepoint", "name": "sp1" },
    { "type": "rollback", "to": "sp1" },
    { "type": "commit" }
  ]
}
// 输出
{ "setupErrors": [], "results": [ ... ], "finalVersion": 1, "resources": { ... } }
```

## 使用

```bash
node cli.js input.json        # 或：node cli.js < input.json
node --test                   # 运行全部测试
```

库接口：`src/engine.js` 的 `runInput(input)`；
`src/calendar.js` 的 `generateCalendar(calendar, tzTables, fromUtcMs, toUtcMs)`。

## 测试记录

见 `test-results.txt`（`node --test` 输出）。验收覆盖：

1. `test/concurrency.test.js`：重叠命令 REVISION 拒绝（证书含双方 ID 与首个重叠毫秒），
   相邻不重叠区间成功；
2. `test/transactions.test.js`：内层失败只回滚内层、外层整体回滚、
   保存点部分保留、未知保存点报错；
3. `test/reference.test.js`：偏移切换夜（+8 → +9:30 半时区 → +8）的周期边界，
   与“枚举所有区间相交组合”的朴素参考算法逐一比对一致。
