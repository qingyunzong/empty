# replayfs

`replayfs` 是一个仅依赖 Go 标准库的文件接口录制/回放测试库。

## 设计

- **`Store` / `FS` / `File`**（`fs.go`）：内存持久存储 + 带写缓冲的文件系统。
  `Write` 只写缓冲，`Sync`/`Close` 才把字节提交到 `Store` —— 每个成功的
  `Sync`/`Close` 就是一个**持久化点**。
- **`Recorder`**（`trace.go`）：包装 `FS`，把每次调用记录为一条 `Entry`
  （操作、路径、参数 `Data`/`N`、返回值 `Err`、是否持久化点 `Persist`）。
  设置 `CrashAt = k` 后，在第 k 个持久化点提交字节**之后**注入中断
  （`ErrCrash`）：已写字节保持不变，后续调用全部失败。
- **`Replayer`**（`trace.go`）：拿轨迹驱动真实 `FS`，**逐项匹配**操作、
  路径、参数，并用录制返回值交叉校验实际结果；`Finish()` 时若存在
  **未消费轨迹**则报错，轨迹耗尽后的多余调用同样报错。
- **快照**（`snapshot.go`）：`Store.Snapshot()` 用 gob 按路径排序编码
  （确定性，可逐字节比较），`RestoreStore` 恢复出完全独立的副本。

## 分段回放与全程一致性的证明

`TestSegmentedReplayEqualsFullRun`：先全程回放整条轨迹得到最终快照
`S_full`；再对每个持久化点 k，回放轨迹前缀（含第 k 个持久化点）→ 保存
快照 → 恢复到全新 `FS` → 回放剩余轨迹（前半段已打开的文件通过
`Replayer.Attach` 接管，仍逐项校验但不消费 Open 轨迹项）→ 得到最终快照
`S_seg`。断言 `bytes.Equal(S_full, S_seg)` 对所有 k 成立。

`TestCrashInjectionAtPersistencePoint`：在第 2 个持久化点注入中断后，
`a.log` 恰好为 `"alpha-beta"`（已提交字节不变），`b.log` 为空；该崩溃
轨迹在新 `FS` 上回放后状态与录制时完全一致。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64，2026-10-05。

```
$ go test ./...
ok  	replayfs	0.004s

$ go test -race -count=1 -v ./...
=== RUN   TestRecordReplayRoundTrip
--- PASS: TestRecordReplayRoundTrip (0.00s)
=== RUN   TestReplayArgumentMismatch
--- PASS: TestReplayArgumentMismatch (0.00s)
=== RUN   TestReplayOperationMismatch
--- PASS: TestReplayOperationMismatch (0.00s)
=== RUN   TestUnconsumedTraceFails
--- PASS: TestUnconsumedTraceFails (0.00s)
=== RUN   TestExhaustedTraceFails
--- PASS: TestExhaustedTraceFails (0.00s)
=== RUN   TestCrashInjectionAtPersistencePoint
--- PASS: TestCrashInjectionAtPersistencePoint (0.00s)
=== RUN   TestSegmentedReplayEqualsFullRun
--- PASS: TestSegmentedReplayEqualsFullRun (0.00s)
=== RUN   TestSnapshotRoundTrip
--- PASS: TestSnapshotRoundTrip (0.00s)
PASS
ok  	replayfs	1.015s
```
