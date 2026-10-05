# resultxchg — 结果交换库

Go 标准库实现的结果交换队列（`exchange` 包），语义如下：

- **原子批量领取**：`Claim(ctx, k)` 在同一把互斥锁内一次性取出至多 k 个
  FIFO 项目；队列为空时阻塞等待，直到有新项目或 ctx 超时。
- **超时不改队列**：超时/取消路径只记录一条 `claim-timeout` 历史事件，
  队列、已领取集、已取消集均不变。
- **取消仅撤回未领取项**：`Cancel(id)` 只从队列中移除仍在排队的项目；
  已领取、已取消或不存在的项目返回 `false`（记 `cancel-miss`）。
- **整次线性化**：所有变更操作全程持有同一把 `sync.Mutex`，因此
  `Cancel` 与批量 `Claim` 各自作为整体线性化——每个项目最终只处于
  队列 / 已领取 / 已取消 三种状态之一，领取批次不会被取消操作切开。
- **状态历史**：每个操作追加一条带序号、批次 k、涉及项目、操作后队列
  长度的 `Event`，可用 `History()` 读取或 `DumpHistory(w)` 输出。

## 守恒检验

`TestConservationEnumeration` 对 8 个操作（3 生产、2 批量领取、3 取消）
的全部 40320 种排列逐一执行，并在每一步之后验证守恒：每个已生产项目
恰好存在于 {队列, 已领取, 已取消} 之一，无丢失、无重复、无凭空出现。
`TestConcurrentClaimCancelLinearize` 以 50 轮并发压力（4 个消费者
k=1..4 与 20 个生产者、20 个取消者竞争）复核同一不变量。

## 实际测试结果（go1.27.1 linux/amd64）

```
$ go test ./...
ok  	resultxchg/exchange	2.778s

$ go test ./... -race -count=1
ok  	resultxchg/exchange	7.994s
```

逐条用例（`go test ./... -v`）：

```
--- PASS: TestClaimTakesUpToK (0.00s)
--- PASS: TestClaimTimeoutLeavesQueueUnchanged (0.03s)
--- PASS: TestCancelOnlyWithdrawsUnclaimed (0.00s)
--- PASS: TestHistoryOutput (0.00s)
--- PASS: TestConservationEnumeration (0.88s)   # 40320 种排列全部守恒
--- PASS: TestConcurrentClaimCancelLinearize (0.03s)
PASS
```
