# scheduler

持久化租约式定时任务调度库，仅使用 Go 标准库。

## 设计

- **排序领取**：`Claim` 按 `(Deadline, ID)` 升序选出下一个可领取任务（`scheduler.go` 中 `less`）。
- **先持久后返回**：每次状态迁移（add/claim/ack）先追加到日志并 `fsync`，再更新内存、再返回（`persist`，阶段 `before-write` / `before-sync` / `after-sync`）。崩溃后要么看到完整记录，要么完全没有。
- **重启与新代**：未确认任务在租约过期后可再次领取，`Generation` 递增；重启后日志重放恢复全部状态。
- **过期/旧代 ACK 拒绝**：`Ack` 校验任务存在、处于 claimed、代匹配（否则 `ErrStaleGeneration`）、租约未过期（否则 `ErrLeaseExpired`）。
- **崩溃注入**：测试通过 `crashHook` 在持久化各阶段关闭日志文件（丢弃未刷盘缓冲）并 panic 模拟进程崩溃，随后从磁盘恢复核对状态。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64。命令：`go test ./... -count=1 -race -v`

```
=== RUN   TestClaimOrderByDeadlineThenID
--- PASS: TestClaimOrderByDeadlineThenID (0.00s)
=== RUN   TestClaimIsDurableBeforeReturn
=== RUN   TestClaimIsDurableBeforeReturn/before-write
=== RUN   TestClaimIsDurableBeforeReturn/before-sync
=== RUN   TestClaimIsDurableBeforeReturn/after-sync
--- PASS: TestClaimIsDurableBeforeReturn (0.00s)
    --- PASS: TestClaimIsDurableBeforeReturn/before-write (0.00s)
    --- PASS: TestClaimIsDurableBeforeReturn/before-sync (0.00s)
    --- PASS: TestClaimIsDurableBeforeReturn/after-sync (0.00s)
=== RUN   TestRestartUnackedReclaimableWithNewGeneration
--- PASS: TestRestartUnackedReclaimableWithNewGeneration (0.00s)
=== RUN   TestExpiredAckRejected
--- PASS: TestExpiredAckRejected (0.00s)
=== RUN   TestAckValidation
--- PASS: TestAckValidation (0.00s)
=== RUN   TestOutOfOrderAcksAndFullState
--- PASS: TestOutOfOrderAcksAndFullState (0.00s)
=== RUN   TestCrashInjectionMatrix
=== RUN   TestCrashInjectionMatrix/before-write
=== RUN   TestCrashInjectionMatrix/before-sync
=== RUN   TestCrashInjectionMatrix/after-sync
--- PASS: TestCrashInjectionMatrix (0.00s)
    --- PASS: TestCrashInjectionMatrix/before-write (0.00s)
    --- PASS: TestCrashInjectionMatrix/before-sync (0.00s)
    --- PASS: TestCrashInjectionMatrix/after-sync (0.00s)
PASS
ok  	scheduler	1.025s
```

`go test ./...`（默认参数）结果：`ok  scheduler  0.004s`。全部 7 个测试（含 6 个子测试）通过，race 检测无告警。
