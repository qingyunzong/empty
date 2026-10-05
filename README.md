# windowagg

按业务时间（事件时间）做半开窗口聚合的统计库，仅使用 Go 标准库。

## 语义

- **半开窗口**：窗口为 `[start, start+size)`，按窗口大小对齐；落在边界上的事件归入右侧窗口。负时间按向下取整处理。
- **水位只增**：水位取迄今为止见过的最大事件时间，单调不减。
- **迟到界限 L**：事件时间 `t >= watermark - L` 被接受；更老的事件被拒绝（`Add` 返回 `false`，计入 `Rejected()`）。
- **更正**：相同 ID 的后到事件视为更正，先撤销该 ID 的旧贡献（原窗口计数减一、求和减去旧值），再按新值计入；更正本身同样受迟到界限约束，被拒绝的更正不影响旧贡献。未知 ID 的“更正”按新事件处理。
- **窗口修订序号**：每个窗口维护 `Revision`，每次计入或撤销加一；被撤销至空的窗口保留修订历史，但不出现在 `Windows()` 快照中。
- **精确性**：聚合器保留全部存活事件与窗口状态，不做清理，因此结果始终可与全量重算（`Recompute`）逐窗口对照。

## API

- `NewAggregator(windowSize, lateness int64) *Aggregator`
- `(*Aggregator).Add(e Event) bool` — 摄入事件/更正，返回是否被接受
- `(*Aggregator).Windows() []Window` — 非空窗口快照（含 `Revision`），按起点升序
- `(*Aggregator).Watermark() (int64, bool)` / `Rejected() int` / `Live() []Event`
- `Recompute(windowSize int64, events []Event) []Window` — 全量重算参照实现

## 测试

`windowagg_test.go` 覆盖：半开边界、负时间、水位单调、迟到界限（含 `t == watermark-L` 边界）、同窗口/跨窗口更正、未知 ID 更正、迟到更正拒绝，以及乱序事件与全量重算的对照（两个子用例：有界乱序 4617 接受 / 383 拒绝，完全乱序 13 接受 / 4987 拒绝；均逐窗口比对计数与求和，并校验水位单调、修订序号下界）。

## 实际测试结果

环境：go1.27.1 linux/amd64（构建缓存重定向至可写目录 `GOCACHE=/tmp/gocache`）。

```
$ go vet ./...   # 通过，无输出
$ go test ./...
ok  	windowagg	0.045s
```

`go test -v -count=1 ./...` 摘要：9 个测试函数（含 2 个子用例）全部 PASS：

```
--- PASS: TestHalfOpenWindowBoundaries (0.00s)
--- PASS: TestNegativeEventTimes (0.00s)
--- PASS: TestWatermarkOnlyIncreases (0.00s)
--- PASS: TestLatenessBound (0.00s)
--- PASS: TestCorrectionSameWindow (0.00s)
--- PASS: TestCorrectionMovesWindow (0.00s)
--- PASS: TestCorrectionUnknownID (0.00s)
--- PASS: TestLateCorrectionRejected (0.00s)
--- PASS: TestOutOfOrderVsFullRecompute (0.02s)
    --- PASS: TestOutOfOrderVsFullRecompute/BoundedDisorder (0.01s)
    --- PASS: TestOutOfOrderVsFullRecompute/FullyShuffled (0.00s)
PASS
ok  	windowagg	0.034s
```
