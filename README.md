# telemetry — 累计指标转速率

从累计计数器采样计算窗口速率，仅使用 Go 标准库。遥测事件在本地以夹具
文件合成并可回放；不接入任何监控平台，也不做展示看板。

## 语义与策略

- **重启（epoch）**：带 `reset` 标记的采样开启新段，计数器假定从 0 重启，
  该点增量取采样值本身（如 100→5 记 +5），绝不产生负速率。
- **无标记回退**：数值下降但无 `reset` 标记时，无法区分重启与数据损坏，
  该区间计为**不确定**（`UncertainDrops`），增量计 0，不伪算负速率。
- **乱序**：采样先按时间稳定排序，乱序送达与顺序送达结果一致。
- **重复时间戳冲突**：同一时间戳出现不同值时按策略取舍
  （`keep-last` / `keep-first` / `keep-max`），并计入 `Conflicts`；
  任一副本带 `reset` 标记都会保留该标记；值相同的重复不算冲突。
- **窗口两端插值**：窗口边界落在段内时线性插值；落在跨越重启的间隙时
  采用零阶保持（取前一个已知值），因为重启时刻未知、跨段插值无意义。
- **窗口钳制**：窗口裁剪到数据覆盖范围，完全不重叠时返回 `ErrNoCoverage`。

## 布局

- `rate.go` — 核心库（`Normalize` / `Rate` / `Report`）
- `rate_test.go` — `go test` 测试
- `cmd/ratecalc` — 夹具回放 CLI
- `testdata/*.txt` — 合成遥测夹具，格式：`<秒> <值> [reset]`，`#` 为注释

## 运行样例

```
$ go run ./cmd/ratecalc -fixture testdata/restart.txt -start 0 -end 30
fixture:  testdata/restart.txt (4 samples, policy keep-last)
window:   [0, 30] (effective [0, 30])
increase: 30 over 30s
rate:     1/s
resets:   1
uncertain drops (unmarked rollback): 0
conflicts (duplicate timestamps):    0

$ go run ./cmd/ratecalc -fixture testdata/rollback.txt -start 0 -end 30
increase: 25 over 30s
rate:     0.8333333333333334/s
uncertain drops (unmarked rollback): 1   # 100→5 无标记，不计负速率

$ go run ./cmd/ratecalc -fixture testdata/conflict.txt -start 0 -end 20 -policy keep-max
increase: 10 over 20s
rate:     0.5/s
conflicts (duplicate timestamps):    1

$ go run ./cmd/ratecalc -fixture testdata/out_of_order.txt -start 0 -end 30
increase: 53 over 30s
rate:     1.7666666666666666/s
resets:   1
```

## 测试结果

`go test ./...`（Go 1.11，12 个用例全部通过）：

```
=== RUN   TestMarkedRestartStartsNewSegment      --- PASS   # 100→5 带标记按新段
=== RUN   TestUnmarkedRollbackIsUncertain        --- PASS   # 无标记回退标不确定
=== RUN   TestNeverNegativeRate                  --- PASS   # 纯下降速率为 0
=== RUN   TestDuplicateTimestampConflictPolicies --- PASS   # keep-last/first/max
=== RUN   TestIdenticalDuplicatesAreNotConflicts --- PASS
=== RUN   TestOutOfOrderSamples                  --- PASS   # 乱序与顺序一致
=== RUN   TestWindowEdgeInterpolation            --- PASS   # 段内线性插值
=== RUN   TestResetGapUsesZeroOrderHold          --- PASS   # 重启间隙零阶保持
=== RUN   TestWindowClampedToCoverage            --- PASS
=== RUN   TestNoCoverage                         --- PASS
=== RUN   TestInvalidWindow                      --- PASS
=== RUN   TestResetFlagSurvivesConflictResolution --- PASS
PASS
ok  	telemetry
```
