# 授权库实现与测试结果

## 需求 → 实现映射（authlib.go）

- **一次令牌允许 k 次整数动作**：`Issue(tokenID, k)` 签发额度；`Use(tokenID, txID, n, effect)` 扣 n 次。
- **扣次和业务提交同日志事务**：一条 commit 日志记录同时携带扣次 `N` 与业务效果 `Effect`，append + fsync 成功即同事务提交（`appendLog`，authlib.go:157）。
- **失败不扣**：校验失败或日志事务失败时不写日志、不改内存状态（`Use`，authlib.go:194）。
- **重复 ID 不再扣**：`txID` 为幂等键，重复提交返回 `ErrDuplicate`，重启后仍有效。
- **撤销与提交按锁内次序**：`Use`/`Revoke`/`Issue` 共用同一把互斥锁，日志顺序即锁内次序。
- **崩溃恢复**：`Open` 重放日志（`recover`，authlib.go:104），撕裂/损坏尾部被截断；已 fsync 的事务精确生效一次。

## 崩溃点与并发核对（authlib_test.go）

- `TestCrashBeforeWrite`：写日志前崩溃 → 剩余次/效果计数不变，txID 可重试。
- `TestCrashBeforeSyncUnsyncedLost`：已写未 fsync，模拟断电丢失 → 不扣次、不计效果。
- `TestCrashAfterSyncBeforeApply`：已 fsync 未应用内存 → 恢复后扣次与效果精确生效一次，重放 txID 幂等。
- `TestTornTailIgnored`：半条撕裂记录被忽略并截断，后续写入正常。
- `TestConcurrentDuplicateRequests`：32 个 goroutine 同一 txID → 恰好 1 次成功，31 次 `ErrDuplicate`。
- `TestConcurrentExhaustion`：50 个 goroutine 竞争 k=20 额度 → 恰好 20 次成功，剩余 0，重启后计数一致。
- `TestRevokeCommitLockOrder`：并发 Use/Revoke ×20 轮，核对成功数+剩余数==k、效果数==成功数、日志中 commit 均在 revoke 之前、撤销后 Use 全部失败。

## 实际测试输出（2026-10-05，go1.27.1 linux/amd64）

`GOCACHE=/tmp/gocache go test ./... -v -count=1`：

```
=== RUN   TestBasicDeductAndEffect
--- PASS: TestBasicDeductAndEffect (0.00s)
=== RUN   TestFailureDoesNotDeduct
--- PASS: TestFailureDoesNotDeduct (0.00s)
=== RUN   TestDuplicateIDNotDeductedAgain
--- PASS: TestDuplicateIDNotDeductedAgain (0.00s)
=== RUN   TestCrashBeforeWrite
--- PASS: TestCrashBeforeWrite (0.00s)
=== RUN   TestCrashBeforeSyncUnsyncedLost
--- PASS: TestCrashBeforeSyncUnsyncedLost (0.00s)
=== RUN   TestCrashAfterSyncBeforeApply
--- PASS: TestCrashAfterSyncBeforeApply (0.00s)
=== RUN   TestTornTailIgnored
--- PASS: TestTornTailIgnored (0.00s)
=== RUN   TestConcurrentDuplicateRequests
--- PASS: TestConcurrentDuplicateRequests (0.00s)
=== RUN   TestConcurrentExhaustion
--- PASS: TestConcurrentExhaustion (0.00s)
=== RUN   TestRevokeCommitLockOrder
--- PASS: TestRevokeCommitLockOrder (0.01s)
PASS
ok  	authlib	0.023s
```

`go test ./... -race -count=1`：

```
ok  	authlib	1.085s
```

10/10 测试通过，race 检测无数据竞争。仅使用 Go 标准库。
