# 实际测试结果

环境：go1.27.1 linux/amd64（仅标准库，无第三方依赖）。
注意：本环境默认 `GOCACHE`（~/.cache/go-build）只读，需指定可写缓存：
`GOCACHE=/tmp/gocache GOPATH=/tmp/gopath go test ./...`

## `go test ./...`

```
ok  	leasequota	0.027s
```
退出码：0

## `go test -race -count=1 -v ./...`（2026-10-05 实际运行）

```
=== RUN   TestDownloadCommitShortWrite
--- PASS: TestDownloadCommitShortWrite (0.00s)
=== RUN   TestDownloadCancelReturnsReservation
--- PASS: TestDownloadCancelReturnsReservation (0.00s)
=== RUN   TestDownloadCommitFailureReturnsReservation
--- PASS: TestDownloadCommitFailureReturnsReservation (0.00s)
=== RUN   TestDownloadCancelAfterCommitFails
--- PASS: TestDownloadCancelAfterCommitFails (0.00s)
=== RUN   TestDownloadLengthGrowsWithinQuota
--- PASS: TestDownloadLengthGrowsWithinQuota (0.00s)
=== RUN   TestDownloadLengthGrowsBeyondQuota
--- PASS: TestDownloadLengthGrowsBeyondQuota (0.00s)
=== RUN   TestDownloadReservationExceedsQuota
--- PASS: TestDownloadReservationExceedsQuota (0.00s)
=== RUN   TestDeleteFreesUsed
--- PASS: TestDeleteFreesUsed (0.00s)
=== RUN   TestInterleavedDownloadsAndDeletes
--- PASS: TestInterleavedDownloadsAndDeletes (0.06s)
=== RUN   TestReserveCommitExact
--- PASS: TestReserveCommitExact (0.00s)
=== RUN   TestCommitShortWriteReturnsReservation
--- PASS: TestCommitShortWriteReturnsReservation (0.00s)
=== RUN   TestReleaseReturnsReservation
--- PASS: TestReleaseReturnsReservation (0.00s)
=== RUN   TestReserveBeyondTotalFails
--- PASS: TestReserveBeyondTotalFails (0.00s)
=== RUN   TestCommitBeyondOutstandingFails
--- PASS: TestCommitBeyondOutstandingFails (0.00s)
=== RUN   TestCommittedLeaseCannotBeCancelled
--- PASS: TestCommittedLeaseCannotBeCancelled (0.00s)
=== RUN   TestReleasedLeaseCannotBeReused
--- PASS: TestReleasedLeaseCannotBeReused (0.00s)
=== RUN   TestLeaseGrow
--- PASS: TestLeaseGrow (0.00s)
=== RUN   TestFree
--- PASS: TestFree (0.00s)
=== RUN   TestConcurrentInvariant
--- PASS: TestConcurrentInvariant (0.07s)
PASS
ok  	leasequota	1.171s
```
退出码：0（19/19 通过，含 race detector）

## 其他检查

- `go vet ./...`：通过，无输出
- `gofmt -l .`：通过，无文件需要格式化
