# quotalib

FIFO 配额库：作业同时申请 CPU 与内存，纯 Go 标准库实现。

## 设计

- **原子授予**：`Acquire` 要么同时授予 CPU 和内存，要么完全不授予，不存在部分占有。
- **严格 FIFO**：资源不足时请求进入等待队列；释放时只从队首开始检查，队首不满足则
  整个队列阻塞（head-of-line blocking），不允许后来者超车。快速路径要求队列为空，
  保证 FIFO 顺序不被插队破坏。
- **取消 vs 授予**：两者都在同一把互斥锁内提交，谁先拿锁谁生效。授予已提交则
  `Acquire` 返回令牌（调用方必须 `Release`）；否则移除等待者并返回 `ctx.Err()`。
- **幂等释放**：`Token.Release` 用 `atomic.CompareAndSwapInt32` 保证只有第一次调用
  生效，并发或重复释放不会重复归还资源。
- **事件日志**：所有状态迁移在锁内追加到事件日志（`Pool.Events`），`Seq` 构成与
  内部状态一致的全序，供线性化验收回放。

## 验收测试（quota_test.go）

- `TestHeadOfLineBlocking`：构造队首阻塞——大队首阻塞小请求，断言小请求不得超车，
  释放后按 FIFO 顺序依次授予。
- `TestDuplicateRelease`：顺序 + 16 路并发重复释放，断言资源只归还一次、容量可完整复用。
- `TestCancelGrantRace`：200 轮取消与授予对撞，每轮恰有一个胜者，资源守恒。
- `TestConservationUnderChaos`：32 goroutine 随机获取/取消/（重复）释放的压力测试。
- `verifyLog`：回放事件日志，验证资源守恒（用量恒在 `[0, capacity]` 且与日志快照一致）、
  每个令牌授予/释放至多一次、等待者授予严格 FIFO、快速路径授予时队列必为空。

## 实际测试结果

```
$ go test ./...
ok  	quotalib	0.960s

$ go test ./... -race -count=5
ok  	quotalib	4.725s
```

（Go 1.27.1 linux/amd64；竞态检测 5 连跑全部通过。）
