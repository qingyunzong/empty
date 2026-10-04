# filetrace

文件接口调用轨迹的录制、严格回放、崩溃注入与分段回放等价性证明。仅使用 Go 标准库。

## 设计

- `memfile.go` — `MemFile`：模拟文件，含易失内容 `data` 与已持久化字节 `durable`。
  `Sync` 是持久化点；`Crash` 模拟断电，易失状态回退到已持久状态，**已持久化字节不变**。
- `trace.go` — `Recorder` 包装 `MemFile`，逐项记录每次调用：操作、参数（写入载荷 /
  读取长度 / Seek 偏移）、返回值（n、位置、错误）；每次 `Sync` 记录持久化点序号
  并保存一份 `Snapshot`（`snapshot.go`）到 `Trace.Snapshots`。
- `replay.go` — `Replayer` 逐项消费轨迹：调用操作、参数必须匹配，并在底层 `MemFile`
  上真实执行以校验返回值一致；任何不匹配即报错。`Finish` 在轨迹未消费完时报错
  （指出下一个未消费事件）。`CrashAt = k` 在第 k 个持久化点的 `Sync` 落盘后注入
  中断：返回 `ErrInjectedCrash`，之后所有调用都报错，已写字节不被改动。
  `Drive`/`ReplayAll` 是通用回放驱动器。

## 分段回放与全程一致性

`Trace.SegmentBounds` 按持久化点把轨迹切成若干段（每段以 `Sync` 结尾，外加尾部段）。
`TestSegmentedReplayEqualsFullRun` 证明：从空文件回放第 0 段，之后每段从前一个持久化
点的快照恢复（`Restore`）再回放，段末状态逐一等于录制时保存的快照，最终状态与全程
回放完全一致。`TestCrashInjectionAtPersistencePoint` 进一步证明：在第 k 个持久点注入
中断后已写/已持久字节不变，且从该点快照恢复并续放剩余事件可得到与全程相同的结果。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64，命令 `go test ./...`：

```
ok  	filetrace	0.003s
```

`go test ./... -v -count=1`：

```
=== RUN   TestRecordAndFullReplay
--- PASS: TestRecordAndFullReplay (0.00s)
=== RUN   TestReplayArgumentMismatch
--- PASS: TestReplayArgumentMismatch (0.00s)
=== RUN   TestReplayResultMismatch
--- PASS: TestReplayResultMismatch (0.00s)
=== RUN   TestUnconsumedTrace
--- PASS: TestUnconsumedTrace (0.00s)
=== RUN   TestCrashInjectionAtPersistencePoint
--- PASS: TestCrashInjectionAtPersistencePoint (0.00s)
=== RUN   TestSegmentedReplayEqualsFullRun
--- PASS: TestSegmentedReplayEqualsFullRun (0.00s)
=== RUN   TestSnapshotRestore
--- PASS: TestSnapshotRestore (0.00s)
PASS
ok  	filetrace	0.003s
```
