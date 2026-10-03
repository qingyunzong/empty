# device-alarm-detector

设备报警检测库与 CLI。Node.js 22，仅使用标准库与 `node:test`，离线单机执行。

## 运行

```sh
node cli.js < commands.jsonl        # JSON 命令行进，JSON 记录行出
node --test                         # 运行全部测试
```

## 模型

- **规则 rule**：周期起点 `periodStart`、周期长度 `periodLength`、应心跳偏移
  `expectedOffset`、宽限期 `grace`、合并间隙 `mergeGap`、可选班次表 `shiftTable`。
  第 k 个周期的基准时刻为 `periodStart + k*periodLength + expectedOffset`，
  应心跳窗口为 `[base + offset, base + offset + grace]`（闭区间），其中
  `offset` 为基准时刻在班次偏移表中的取值。
- **班次偏移表 shiftTable**：`[{start, end, offset}]`，半开区间 `[start, end)`。
  条目重叠在定义时报错；扫描时基准时刻无条目覆盖即"偏移表缺口"错误。
- **报警**：连续缺失心跳的周期形成报警区间 `[首个缺失周期窗口起点,
  末个缺失周期窗口终点]`；被后续心跳或停机打断的为 `CLOSED`，一直延续到
  截止时刻的为 `OPEN`（`end = cutoff`）。相邻同规则报警间隙
  `<= mergeGap` 时合并。
- **计划停机 downtime**：窗口被停机区间（闭区间）完全覆盖的周期豁免，
  不报警且会截断当前缺失序列；窗口与停机部分相交时，心跳必须落在
  窗口减去停机的部分——跨越停机边界前后的心跳分别判断。
- **事件**：心跳支持追加（`heartbeat`）、撤回（`retract`）、覆盖更正
  （`override`）。每次更正使受影响规则版本 +1，重扫并输出证书；证书含
  扫描区间、周期数及全部周期边界的 SHA-256，证明扫描过的周期边界。
- **截止 cutoff**：扫描视界。窗口右端超过 cutoff 的周期尚未到期，不判定。
  未收到结束信息不是错误；尾部未闭合的报警标记 `OPEN`。

## 命令协议（JSONL）

输入（每行一个 JSON 对象）：

| cmd | 字段 | 说明 |
| --- | --- | --- |
| `shiftTable` | `id`, `offsets:[{start,end,offset}]` | 定义班次偏移表 |
| `rule` | `id`, `device`, `periodStart`, `periodLength`, `expectedOffset?`, `grace?`, `mergeGap?`, `shiftTable?` | 定义规则 |
| `heartbeat` | `id`, `device`, `time` | 追加心跳事件 |
| `retract` | `id` | 撤回事件 |
| `override` | `id`, `time` | 覆盖更正事件时刻 |
| `downtime` | `device`, `start`, `end` | 追加计划停机区间 |
| `cutoff` | `time` | 设置截止时刻 |
| `scan` | — | 扫描全部规则并输出报警 |

输出（每行一个 JSON 记录）：

- `{"type":"ack", ...}`：定义类命令确认。
- `{"type":"alarms", "rule", "version", "certificate", "alarms":[{start,end,status,missedPeriods}]}`：扫描结果。
- `{"type":"correction", "kind":"retract"|"override", "event", "affected":[{rule,version,certificate,alarms}]}`：更正结果。
- `{"type":"error", "error":CODE, "message", ...}`：错误。`ZERO_PERIOD`
  （周期为零）、`OFFSET_GAP`（偏移表缺口）、`TIME_INVERSION`（事件时间
  倒错：同一设备事件时间非单调）、`OFFSET_TABLE_OVERLAP`、
  `DUPLICATE_*`、`UNKNOWN_*`、`NO_CUTOFF`、`BAD_JSON` 等。

CLI 出现任何错误记录时退出码为 1，否则为 0。

## 证书

`certificate = {rule, version, from, to, periodCount, boundariesHash}`，
其中 `boundariesHash` 为扫描到的周期边界序列
`[S, S+L, ..., S+n*L]` 的 JSON 的 SHA-256。

## 测试

- `test/acceptance.test.js`：三个验收场景——跨班次偏移切换的三个周期；
  撤回心跳生成报警并与后续报警合并；停机边界与开放区间，并与
  `src/reference.js`（逐周期枚举心跳集合的参考算法）对照，另含 300 组
  随机模糊对照。
- `test/errors.test.js`：错误路径（零周期、偏移表缺口、时间倒错等）。
- `test/cli.test.js`：CLI JSONL 端到端。
