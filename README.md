# quota — 别名图限额库

仅使用 Go 标准库实现。

## 设计

- **别名图解析主体**：`Store.alias` 保存名称间的别名边，`Resolve` 沿边走到
  无出边的主体根。`Rename` 把主体记录改键到新名并留下 `old -> new` 别名，
  因此旧别名上的请求沿新根计费（`Consume`/`AcquireLease` 都先解析）。
- **环报告**：`ReportCycles` 用三色 DFS 报告别名图中的全部环；`Resolve`
  遇到环返回 `*CycleError`（含环路径），消费等操作随之失败。
- **原子合并**：`Merge(dst, src)` 先完整解析并校验（含租约 ID 冲突），
  再一次性合并限额、余额、已消费与活租约，把 src 根变为 dst 根的别名；
  任一步失败不产生部分状态。
- **分裂约束**：`Split` 仅在源主体无活租约时允许，划出部分限额为新主体。
- **租约**：`AcquireLease` 锁定余额，`ReleaseLease` 退回，`CommitLease` 转为消费；
  合并后旧主体上的租约仍归属新根。
- **重放与守恒**：`ParseEvents` 解析文本事件日志（rename/consume/merge/split/
  lease/release/commit），`Replay` 逐条应用并收集错误；`VerifyConservation`
  核对每个主体及全局的 `余额 + 在租 + 已消费 == 限额`。

## 实测结果

```
$ GOCACHE=/tmp/gocache go test ./... -v
=== RUN   TestRenameResolveAndOldAliasBilling
--- PASS: TestRenameResolveAndOldAliasBilling (0.00s)
=== RUN   TestCycleReport
--- PASS: TestCycleReport (0.00s)
=== RUN   TestMergeAtomicBalancesAndLeases
--- PASS: TestMergeAtomicBalancesAndLeases (0.00s)
=== RUN   TestFailedMergeIsAtomic
--- PASS: TestFailedMergeIsAtomic (0.00s)
=== RUN   TestSplitRequiresNoActiveLeases
--- PASS: TestSplitRequiresNoActiveLeases (0.00s)
=== RUN   TestConsumeInsufficient
--- PASS: TestConsumeInsufficient (0.00s)
=== RUN   TestReplayRenameConsumeAndConservation
--- PASS: TestReplayRenameConsumeAndConservation (0.00s)
=== RUN   TestReplaySplitBlockedByLease
--- PASS: TestReplaySplitBlockedByLease (0.00s)
PASS
ok  	quota	0.027s
```

8/8 通过（go1.27.1 linux/amd64，2026-10-06）。
