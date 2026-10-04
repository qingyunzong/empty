# 测试执行记录

环境：go1.27.1 linux/amd64（`GOCACHE=/tmp/gocache`，因 `$HOME/.cache` 只读）。

## `go test ./... -count=1 -v`（2026-10-05 实际输出）

```
=== RUN   TestUnwrittenPageReadsZero
--- PASS: TestUnwrittenPageReadsZero (0.00s)
=== RUN   TestForkIsolationBothDirections
--- PASS: TestForkIsolationBothDirections (0.00s)
=== RUN   TestRefCountsAndReclamation
--- PASS: TestRefCountsAndReclamation (0.00s)
=== RUN   TestPartialWritePreservesRest
--- PASS: TestPartialWritePreservesRest (0.00s)
=== RUN   TestClosedSnapshotRejectsOps
--- PASS: TestClosedSnapshotRejectsOps (0.00s)
=== RUN   TestWriteOverflowRejected
--- PASS: TestWriteOverflowRejected (0.00s)
=== RUN   TestDeepForkChain
--- PASS: TestDeepForkChain (0.02s)
PASS
ok  	pagesnap	0.028s
?   	pagesnap/cmd/pagediag	[no test files]
?   	pagesnap/model	[no test files]
=== RUN   TestRandomHistoriesAgainstModel
--- PASS: TestRandomHistoriesAgainstModel (5.43s)
=== RUN   TestKeepOpenRefcounts
--- PASS: TestKeepOpenRefcounts (0.25s)
PASS
ok  	pagesnap/workload	5.689s
```

`go vet ./...` 通过，`gofmt -l .` 无输出。

## 诊断 CLI（实际输出）

```
$ go run ./cmd/pagediag run -seed 1 -ops 5000 -snaps 16 -pages 64
stats: live-pages=0 live-snapshots=0 total-refs=0 allocs=2806 frees=2806 cow-copies=1971
PASS seed=1 ops=5000 snaps<=16 pages<64: model-identical, all pages reclaimed

$ go run ./cmd/pagediag refs -seed 7 -ops 3000
stats: live-pages=276 live-snapshots=15 total-refs=845 allocs=1648 frees=1372 cow-copies=967
live snapshots: [261 273 275 293 295 298 303 304 305 306 308 311 312 313 314]
physical page reference table:
  phys=4      refs=2
  phys=6      refs=7
  ...
refcount invariant: OK
```

## 结论

- 7 个单元测试 + 25 个种子的随机分叉历史对照测试全部通过。
- 随机历史与深复制模型逐读比对零发散；全部分支关闭后
  `live-pages=0`、`allocs == frees`，无泄漏。
- `refs` 模式保留存活视图时页不被回收，引用表经
  `VerifyRefCounts` 校验精确一致。
