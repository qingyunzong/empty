# device-status-calendar

设备状态日历库及 CLI。Node.js 22，仅标准库与 `node:test`，离线单机执行。

## 模型

- **区间**：一律为半开 `[start, end)`，epoch 毫秒整数。相邻区间（`a.end === b.start`）不重叠。
- **时区表**（`src/timezone.js`）：显式提供，每个时区是一组时代 `{from: <utc ms>, offsetMinutes}`。
  `localToUtc` 按时代本地跨度 `[from_i + off_i, from_{i+1} + off_i)` 解析；前向切换产生的
  本地时间空洞报 `INVALID_LOCAL_TIME`（周期展开时跳过该次），回退切换的重叠取最早时代。
- **日历**（`src/calendar.js`）：带时区的周期班次（daily/weekly、`timeOfDay`、`durationMinutes`）、
  停产例外（从班次中扣减）、半开交接区间（直接并入）。`busyIntervals(window)` 输出裁剪到窗口的忙碌区间。
- **并发引擎**（`src/engine.js`）：服务器式单机判定。每条已提交命令使全局版本 +1 并记录其写入区间。
  命令携带 `baseVersion`；若同资源上存在 `version > baseVersion` 的已提交区间与命令读取区间重叠，
  拒绝 `REVISION` 并输出冲突证书 `{commandId, conflictCommandId, resource, firstOverlapMs}`
  （首个重叠毫秒 = 两个起点的大者）。
- **事务**：`begin`（可嵌套）/ `savepoint` / `release` / `rollbackTo` / `commit` / `rollback`。
  事务内命令先写入日志；命令冲突失败时只回滚最内层事务已写入的区间，外层事务及其保存点保留，
  可继续提交（部分保留）。内层 `commit` 合并进外层日志，最外层 `commit` 才落库并分配版本。
- **错误**：`ZERO_DURATION`（零时长周期/区间）、`INVERTED_INTERVAL`（区间反转）、
  `UNKNOWN_SAVEPOINT`（未知保存点）、`REVISION`（版本冲突）等。

## CLI

```
node src/cli.js [input.json]   # 省略路径或传 - 时从 stdin 读取
```

输入：`{timezones, calendar, ops}`；`ops` 为事务流（事务操作 + `command`，另有只读的
`expand` / `busy` 日历查询）。输出：`{version, results}`，每个 op 一个结果。

## 测试

```
node --test
```

- `test/engine.test.js`：验收 1（重叠拒绝 + 证书、相邻成功）与验收 2（内层失败回滚、
  外层回滚、保存点部分保留）。
- `test/calendar.test.js`：时区转换、偏移切换夜的周期边界、空洞/回退、例外扣减、错误校验。
- `test/reference.test.js`：验收 3——独立参考算法（候选时代回验的 local→utc、端点切分
  逐段枚举覆盖、逐毫秒集合暴力求交）交叉校验偏移切换夜的展开与所有区间相交组合。
- `test/cli.test.js`：JSON 事务流入/出的端到端语义。
