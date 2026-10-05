# clocksim

不确定性时钟模拟库（仅 Go 标准库）。

## 模型

- 每个节点的时钟给出一个区间 `Interval{Earliest, Latest}`，真实"现在"落在区间内。
- 写提交时记录提交区间，`Commit.Latest` 即提交上界。
- 读可见规则：读者的 `Earliest > Commit.Latest`（读者最早可能的"现在"严格晚于写提交上界）时才可返回，见 `node.go` 的 `VisibleAt`。
- 等待通过虚拟 tick 推进（`ManualClock.Tick`）；某次 tick 区间无进展（时钟停滞）立即返回未决 `PendingNoProgress`；tick 预算耗尽返回 `PendingTickLimit`。
- 每次等待输出 `WaitEvidence`：起始区间、每次 tick 后的区间、结束区间与结局。
- `verify.go` 的 `EnumerateOverlaps` 枚举所有读者区间与提交区间重叠的读事件（这些事件绝不允许被服务），`Verify` 校验所有已服务读均未提前。

## 实测结果（go1.27.1 linux/amd64）

```
$ GOCACHE=/tmp/gocache go test ./... -v
=== RUN   TestReadNotVisibleBeforeCommitBound
--- PASS: TestReadNotVisibleBeforeCommitBound (0.00s)
=== RUN   TestWaitForVisibleSucceeds
    evidence: node=r key=k commitLatest=20 start=[0,20] ticks=3 end=[30,50] outcome=visible
--- PASS: TestWaitForVisibleSucceeds (0.00s)
=== RUN   TestWaitPendingNoProgress
    evidence: node=r key=k commitLatest=20 start=[0,20] ticks=1 end=[0,20] outcome=pending-no-progress
--- PASS: TestWaitPendingNoProgress (0.00s)
=== RUN   TestWaitPendingTickLimit
    evidence: node=r key=k commitLatest=20 start=[0,20] ticks=2 end=[20,40] outcome=pending-tick-limit
--- PASS: TestWaitPendingTickLimit (0.00s)
=== RUN   TestEnumerateOverlapsVerifyNoEarlyReads
    evidence: node=r key=a commitLatest=30 start=[5,35] ticks=4 end=[33,63] outcome=visible
    evidence: node=r key=b commitLatest=45 start=[33,63] ticks=2 end=[47,77] outcome=visible
    overlap: reader=r[5,35] commit=w1[0,30] served=false
--- PASS: TestEnumerateOverlapsVerifyNoEarlyReads (0.00s)
=== RUN   TestVerifyCatchesEarlyRead
--- PASS: TestVerifyCatchesEarlyRead (0.00s)
PASS
ok  	clocksim	0.005s
```

6/6 通过，`go vet` 无告警。
