# chansim

Go 通道模拟库（仅使用标准库）。整个模拟在单个包级锁上串行化，
每次提交（发送、接收或 select 分支）都是原子的。

## 语义

- **有缓冲收发**：`New(cap)` 创建容量为 `cap` 的通道；缓冲满时
  `Send` 阻塞，空时 `Recv` 阻塞。`cap == 0` 为会合通道：发送仅在
  有接收者阻塞等待时提交。
- **select**：`Select(cases...)` 阻塞至某分支就绪；多个分支同时就绪时
  **选择下标最小的分支**。一次选择只提交一个分支，其余分支上的登记
  （接收等待计数）在返回前全部撤销，失败的发送分支不会留下"幽灵发送"。
  `SelectNow` 为非阻塞版本，无就绪分支时返回下标 -1。
- **关闭**：`Close` 后接收先排空缓冲，再返回零值 `(nil, false)`；
  关闭后（或阻塞中遇到关闭）的发送失败，返回 `false`，不 panic。
  关闭通道上的发送分支在 select 中就绪度恒为假，永远不会被选中。

## 验证

- `chan_test.go`：FIFO、阻塞/唤醒、关闭排空、发送失败、会合、
  最小下标优先、单分支提交无幽灵、登记撤销、并发无幽灵等单元测试。
- `exhaustive_test.go`：穷举小事件模型检验——在两条通道（容量 1 与 2）
  上枚举 10 种事件（发送/接收/关闭/四种 select 组合）所有长度 ≤ 5 的
  序列共 100,000 条，逐条重放并与独立模型对照，断言：无幽灵发送
  （接收到的值必须来自已提交的发送且至多接收一次）、select 单分支提交
  后通道状态与模型完全一致、被选中分支恒为最小就绪下标。

## 实际测试结果

```
$ go test ./...
ok  	chansim	0.442s

$ go test -race -count=1 -v ./...
=== RUN   TestBufferedSendRecvFIFO
--- PASS: TestBufferedSendRecvFIFO (0.00s)
=== RUN   TestSendBlocksUntilSpace
--- PASS: TestSendBlocksUntilSpace (0.05s)
=== RUN   TestRecvBlocksUntilSend
--- PASS: TestRecvBlocksUntilSend (0.05s)
=== RUN   TestCloseDrainThenZero
--- PASS: TestCloseDrainThenZero (0.00s)
=== RUN   TestSendOnClosedFails
--- PASS: TestSendOnClosedFails (0.00s)
=== RUN   TestBlockedSendFailsOnClose
--- PASS: TestBlockedSendFailsOnClose (0.05s)
=== RUN   TestUnbufferedRendezvous
--- PASS: TestUnbufferedRendezvous (0.05s)
=== RUN   TestSelectSmallestIndexWins
--- PASS: TestSelectSmallestIndexWins (0.00s)
=== RUN   TestSelectSingleCommitNoGhost
--- PASS: TestSelectSingleCommitNoGhost (0.00s)
=== RUN   TestSelectBlocksAndRevokesRegistrations
--- PASS: TestSelectBlocksAndRevokesRegistrations (0.05s)
=== RUN   TestSelectRecvOnClosed
--- PASS: TestSelectRecvOnClosed (0.00s)
=== RUN   TestSelectSendOnClosedNeverChosen
--- PASS: TestSelectSendOnClosedNeverChosen (0.00s)
=== RUN   TestConcurrentNoGhost
--- PASS: TestConcurrentNoGhost (0.01s)
=== RUN   TestExhaustiveSmallEvents
    exhaustive_test.go:275: exhaustively verified 100000 event sequences of depth 5 over 10 event kinds
--- PASS: TestExhaustiveSmallEvents (3.18s)
PASS
ok  	chansim	4.488s
```
