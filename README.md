# counterrate

累计计数器（cumulative counter）→ 速率（rate/s）转换器。纯 Go 标准库，
遥测事件本地合成、由 JSONL 夹具回放；不接监控平台，不做展示看板。

## 语义约定

- **乱序**：样本可按任意顺序摄入，查询时按时间戳排序（稳定排序）。
- **重启 epoch**：`restart=true` 的样本开启新段（segment）。计数器只在段内
  保证单调。例：`100 → 5` 带重启标记时按新段计算，窗口记录 `resets=1`，
  不产生负 delta。
- **无标记回退**：段内出现值下降视为未知重置。负 delta 一律跳过——
  **绝不伪算负速率**——所在窗口标记 `Uncertain`。
- **重复时间戳**：值相同直接去重；值不同按冲突策略处理：
  `last`（默认，后写入胜出）/ `first` / `max` / `error`（拒绝并报
  `ErrConflict`）。冲突次数计入 `Series.Conflicts`。
- **窗口两端插值**：边界落在两个样本之间时线性插值；落在数据范围之外时
  钳制到最近样本（clamp），**绝不外推**。
- **窗口速率**：`rate = 窗口内正 delta 之和 / 窗口时长`，跨段窗口把各段
  截断后分别累加。

## 布局

- `series.go` — Sample / Series / 冲突策略 / 排序去重分段
- `rate.go` — 窗口速率、边界插值与钳制、未知重置处理
- `fixture.go` — JSONL 夹具回放（`ts` 支持 RFC3339 或 unix 秒）
- `cmd/ratecalc` — 命令行回放器
- `testdata/` — 演示夹具

## 运行样例

```console
$ go build -o ratecalc ./cmd/ratecalc

$ ./ratecalc -file testdata/restart_marked.jsonl -window 1m
replayed 6 samples, 2 segment(s), 0 conflict(s), span 2026-09-27T00:00:00Z .. 2026-09-27T00:02:30Z
[00:00:00 .. 00:01:00] rate=  2.0000/s increase=   120.0 resets=0 samples=1
[00:01:00 .. 00:02:00] rate=  0.5000/s increase=    30.0 resets=1 samples=1
[00:02:00 .. 00:02:30] rate=  2.0000/s increase=    60.0 resets=0 samples=0

$ ./ratecalc -file testdata/rollback_unmarked.jsonl -window 1m
replayed 5 samples, 1 segment(s), 0 conflict(s), span 2026-09-27T00:00:00Z .. 2026-09-27T00:02:00Z
[00:00:00 .. 00:01:00] rate=  1.0000/s increase=    60.0 resets=0 samples=1 UNCERTAIN(unmarked-reset)
[00:01:00 .. 00:02:00] rate=  1.5000/s increase=    90.0 resets=0 samples=1

$ ./ratecalc -file testdata/conflicts_shuffled.jsonl -window 1m -policy max
replayed 5 samples, 1 segment(s), 1 conflict(s), span 2026-09-27T00:00:00Z .. 2026-09-27T00:03:00Z
[00:00:00 .. 00:01:00] rate=  1.6667/s increase=   100.0 resets=0 samples=0
[00:01:00 .. 00:02:00] rate=  1.6667/s increase=   100.0 resets=0 samples=0
[00:02:00 .. 00:03:00] rate=  1.0000/s increase=    60.0 resets=0 samples=0

$ ./ratecalc -file testdata/conflicts_shuffled.jsonl -policy error
counterrate: conflicting values for identical timestamp: ts=2026-09-27T00:01:00Z (2 values)
```

## 测试结果

```console
$ go test ./... -v
=== RUN   TestReplayFixtureShuffled
--- PASS: TestReplayFixtureShuffled (0.00s)
=== RUN   TestMarkedRestartStartsNewSegment
--- PASS: TestMarkedRestartStartsNewSegment (0.00s)
=== RUN   TestUnmarkedRollbackIsUncertain
--- PASS: TestUnmarkedRollbackIsUncertain (0.00s)
=== RUN   TestBoundaryInterpolation
--- PASS: TestBoundaryInterpolation (0.00s)
=== RUN   TestBoundaryClampNoExtrapolation
--- PASS: TestBoundaryClampNoExtrapolation (0.00s)
=== RUN   TestEmptyWindowRejected
--- PASS: TestEmptyWindowRejected (0.00s)
=== RUN   TestResetOutsideWindowNotCounted
--- PASS: TestResetOutsideWindowNotCounted (0.00s)
=== RUN   TestOutOfOrderEqualsOrdered
--- PASS: TestOutOfOrderEqualsOrdered (0.00s)
=== RUN   TestConflictPolicies
=== RUN   TestConflictPolicies/last-wins
=== RUN   TestConflictPolicies/first-wins
=== RUN   TestConflictPolicies/max-wins
=== RUN   TestConflictPolicies/error-policy
=== RUN   TestConflictPolicies/identical-duplicates-are-not-conflicts
--- PASS: TestConflictPolicies (0.00s)
    --- PASS: TestConflictPolicies/last-wins (0.00s)
    --- PASS: TestConflictPolicies/first-wins (0.00s)
    --- PASS: TestConflictPolicies/max-wins (0.00s)
    --- PASS: TestConflictPolicies/error-policy (0.00s)
    --- PASS: TestConflictPolicies/identical-duplicates-are-not-conflicts (0.00s)
PASS
ok  	counterrate
```
