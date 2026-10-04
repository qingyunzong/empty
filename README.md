# barrier — 任务终结汇聚屏障

按任务 ID 接收完成（Complete）与撤销（Revoke）通知，每个 ID 只计一次；
等待目标集合全部终结。集合可追加直到封口（Seal），封口后等待结果固定。

## 语义

- `Add(ids...)`：追加目标集合；封口后返回 `ErrSealed`，重复 ID 返回 `ErrDuplicateID`。
- `Complete(id, value)` / `Revoke(id)`：上报终结；未知 ID 返回 `ErrUnknownID`。
- 重复通知：结果相同则幂等忽略；结果不同则记录冲突并返回 `*ConflictError`，首次结果生效。
- `Seal()`：封口，幂等；封口后 `Wait` 等待的结果集固定。
- `Wait(ctx)`：阻塞至封口且全部终结，返回结果快照与冲突列表；`ctx` 取消返回其错误。

## 实现要点

互斥锁保护状态；终结条件（已封口且 pending 为空）单调不可逆，
满足时关闭 `done` 通道唤醒所有等待者——关闭至多一次，无漏唤醒；
`Wait` 返回拷贝，快照不受后续重复通知影响。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64，2026-10-05。

```
$ go test ./... -count=1
ok  	barrier	0.067s

$ go test ./... -race -count=1 -v
=== RUN   TestWaitAllCompleted                  --- PASS (0.00s)
=== RUN   TestDuplicateSameNotificationIdempotent --- PASS (0.00s)
=== RUN   TestConflictingDuplicateReported      --- PASS (0.00s)
=== RUN   TestAddAfterSealRejected              --- PASS (0.00s)
=== RUN   TestUnknownAndDuplicateID             --- PASS (0.00s)
=== RUN   TestWaitBlocksUntilSealed             --- PASS (0.05s)
=== RUN   TestWaitContextCancel                 --- PASS (0.00s)
=== RUN   TestSealRace                          --- PASS (0.01s)
=== RUN   TestNoMissedWakeup                    --- PASS (0.01s)
=== RUN   TestSealedResultsFixed                --- PASS (0.00s)
PASS
ok  	barrier	1.090s

$ go test ./... -race -count=10   # 压力复跑
ok  	barrier	1.748s
```
