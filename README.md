# sharedres/fence

基于栅栏号（fencing token）的共享资源库，仅使用 Go 标准库。

## 语义

- `Grant(key, holder)`：每次授予写权限都分配**严格递增**的栅栏号，号码在返回前持久化到状态文件。
- `Write(key, holder, fence, value)`：仅当栅栏号**不低于该 key 当前最大号**且**持有者与当前授权匹配**时接受写入。
- 旧号重试返回 `ErrStale`，不会覆盖更新值；持有者不匹配返回 `ErrNotHolder`。
- `Open(path)` 故障恢复时从状态文件还原已持久化的最大栅栏号，保证重启后号码不回退。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64

```
$ go test ./... -count=1 -v
=== RUN   TestGrantStrictlyIncreasing
--- PASS: TestGrantStrictlyIncreasing (0.00s)
=== RUN   TestWriteAcceptedForCurrentHolder
--- PASS: TestWriteAcceptedForCurrentHolder (0.00s)
=== RUN   TestWriteRejectedForWrongHolder
--- PASS: TestWriteRejectedForWrongHolder (0.00s)
=== RUN   TestStaleRetryDoesNotClobber
--- PASS: TestStaleRetryDoesNotClobber (0.00s)
=== RUN   TestRecoveryPersistsMaxFence
--- PASS: TestRecoveryPersistsMaxFence (0.00s)
=== RUN   TestConcurrentWrites
--- PASS: TestConcurrentWrites (0.01s)
=== RUN   TestConcurrentStaleRetryAfterRace
--- PASS: TestConcurrentStaleRetryAfterRace (0.00s)
PASS
ok  	sharedres/fence	0.017s

$ go test ./... -race -count=1
ok  	sharedres/fence	1.043s
```

7 个测试全部通过（含 `-race`）。并发测试枚举 64 个 goroutine 竞争授权与写入，
核对栅栏号唯一、仅最大号写入成功、其余全部返回 `ErrStale` 且最终值未被旧号覆盖。
