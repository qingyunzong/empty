# ptxn — 分区事务库

仅使用 Go 标准库实现的分区（分片）事务型键值存储。

## 语义

- **按事务 ID 驱动**：`Prepare(id, reads, writes)` 把完整读写集绑定到事务 ID；
  `Commit(id)` / `Abort(id)` 仅凭 ID 决议。
- **决议先持久后可见**：commit/abort 决议先追加到 WAL 并 fsync，之后才对各分区生效；
  崩溃恢复时重放 WAL，保证跨分区**统一可见**——要么全提交，要么全未可见。
- **未决键拒绝读**：处于 prepared（未决议）状态的事务覆盖的键，在恢复前后都以
  `ErrPending` 拒绝读，直到显式 Commit/Abort。
- **超时不等于撤销**：库内没有任何基于超时的自动撤销；未决事务只能由显式决议终结。

## 文件

- `store.go` — 分区存储、Prepare/Commit/Abort/Get、恢复逻辑、故障注入点
- `wal.go` — 追加式 WAL，逐条 fsync，重放时忽略撕裂尾部
- `store_test.go` — 含穷举故障注入测试（9 个崩溃点 × 恢复后全或无核对）

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64（GOCACHE=/tmp/gocache，因默认缓存目录只读）

```
$ go test ./... -v
=== RUN   TestPrepareCommitVisibleAcrossPartitions
--- PASS: TestPrepareCommitVisibleAcrossPartitions (0.00s)
=== RUN   TestAbortNeverVisible
--- PASS: TestAbortNeverVisible (0.00s)
=== RUN   TestPendingKeyRejectsReadBeforeAndAfterRecovery
--- PASS: TestPendingKeyRejectsReadBeforeAndAfterRecovery (0.00s)
=== RUN   TestTimeoutIsNotAbort
--- PASS: TestTimeoutIsNotAbort (0.15s)
=== RUN   TestPrepareConflictOnLockedKey
--- PASS: TestPrepareConflictOnLockedKey (0.00s)
=== RUN   TestDecisionErrors
--- PASS: TestDecisionErrors (0.00s)
=== RUN   TestExhaustiveFaultInjection  (9 个子用例全部 PASS)
--- PASS: TestExhaustiveFaultInjection (0.00s)
=== RUN   TestRecoveryReplaysMixedTransactions
--- PASS: TestRecoveryReplaysMixedTransactions (0.00s)
PASS
ok  	ptxn	0.160s

$ go test ./... -race -count=1
ok  	ptxn	1.197s
```
