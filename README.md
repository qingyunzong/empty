# drr — 赤字轮询（Deficit Round Robin）多租户调度库

## 语义

- 每轮为每个活跃租户（队列非空）增加 `weight * quantum` 的整数配额；
- 队首任务费用超过当前赤字余额时，本轮跳过，赤字累计到下一轮；
- 队列清空时赤字计数器清零，租户退出活跃列表，重新入队时从零开始；
- 负费用任务入队即被拒绝（`ErrNegativeCost`）；
- `SetWeight` 的权重更新在下一轮 `RunRound` 开始时生效；
- 每次扣费追加一条 `LedgerEntry` 账本记录，`Ledger()` 返回完整账本。

## 用法

```go
s, _ := drr.New(100)          // 单位权重每轮配额 100
s.AddTenant("a", 1)
s.AddTenant("b", 2)
s.Enqueue("a", drr.Task{ID: "job-1", Cost: 250})
entries := s.RunRound()       // 本轮新增账本；job-1 费用不足，赤字累计
entries = s.RunRound()        // 赤字 200 仍不足
entries = s.RunRound()        // 赤字 300 >= 250，扣费并记账
```

## 测试

```sh
go test ./...
```

测试包含单元测试，以及一个基于 `container/list` 的独立参考模型：
随机操作序列交叉核验账本逐条一致，并验证大任务不会因队首阻塞而饥饿。
