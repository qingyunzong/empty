# fsmproto — 基于公开有限状态表的协议库

仅使用 Go 标准库。

## 设计

- **公开有限状态表授权动作**（`fsm/table.go`）：调用方用 `NewTable(initial, []Transition)`
  构建可公开检视的 `Table`（`Transitions()` / `Lookup()` 均导出），`Engine.Apply`
  对每条动作查表授权，表外动作返回 `ErrActionNotAuthorized`。
- **状态迁移记录先持久后返回**（`fsm/wal.go`、`fsm/engine.go`）：`Engine.Apply` 先把
  `Record` 追加到 WAL（`write` + `fsync`），成功后才更新内存并返回。`TestPersistBeforeReturn`
  用独立读者在写入方未关闭的情况下验证记录已落盘。
- **重复幂等键只能绑定同动作**：幂等键全局绑定 `(session, action)`。同键同动作重放
  已记录的结果且不产生新写；同键不同动作（或不同会话）返回 `ErrIdempotencyConflict`。
  绑定关系随日志持久化，重启后仍生效。
- **过期会话拒绝迁移**：`StartSession(id, ttl)` 把 `ExpiresAt` 持久化进会话记录；
  `now >= ExpiresAt` 后新迁移返回 `ErrSessionExpired`，重启后仍然拒绝。
- **逐写点中断重启，对照串行表解释器**（`fsm/crash_test.go`、`fsm/interpreter.go`）：
  提交路径暴露三个写点（`PointBeforeWrite` / `PointBeforeSync` / `PointAfterSync`），
  测试用 `CrashHook` 在每一处写点注入掉电（丢弃未 fsync 的字节）并重启，再把恢复后的
  `Engine` 状态与独立的串行表解释器 `Interpreter` 对同一份持久日志的串行回放结果逐一
  比对（`Interpreter` 同时校验日志中每条迁移都被状态表授权）。固定脚本覆盖全部 27 个
  写点，另有 20 组随机脚本 × 随机写点的崩溃对照。

## 实际测试结果

环境：go1.27.1 linux/amd64（沙箱中需 `GOCACHE=/tmp/gocache`，默认构建缓存只读）。

```
$ go test ./...
ok  	fsmproto/fsm	0.023s

$ go test -race -count=1 ./...
ok  	fsmproto/fsm	1.146s
```

`go test -v` 摘要（全部 PASS，无 FAIL）：

- `TestTableIsPublicAndValidates`
- `TestAuthorizeByPublicTable`
- `TestPersistBeforeReturn`
- `TestIdempotencyKeyBindsToOneAction`
- `TestExpiredSessionRejectsTransition`
- `TestRecoveryReplaysLog`
- `TestCrashAtEveryWritePoint`（write-point-0 … write-point-26，共 27 个子测试）
- `TestCrashRandomized`（trial-0 … trial-19，共 20 个子测试）
