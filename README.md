# 层级配额计算器

`formal` 提供一个并发安全的 Go 层级配额计算器，供准入（admission）与调度
（scheduling）调用。配额节点组成一棵树：节点上的请求会同时消耗自身和所有祖先
节点的容量，因此命名空间、优先级以及嵌套/重叠配额都通过同一组硬上限约束。

## 核心语义

- 资源量均为非负整数；`Resources` 中缺失的资源视为 0。
- 节点 `Limit` 中缺失的资源表示该节点不限制该资源，显式写 0 表示硬性归零。
- 每个节点按后代请求量分配父节点授予的容量，同时受本节点硬上限约束。
- 整数余量采用最大余数法（largest remainder），先按余数、再按优先级和稳定
  node id 决胜，结果可复现。
- `Reserve`/`Admit` 全量预留，容量不足时原子失败；`TryReserve` 预留当前能容纳
  的最大部分。
- `Commit` 将预留转为已分配；`Release`/`Cancel` 归还容量。
- `Preempt`/`PreemptBelow` 从低优先级开始回收；同优先级内按当前授予量比例分摊，
  并保证回收总量守恒。容量确实不足时返回 `ErrReclaimShortfall`，已回收部分仍生效。
- 任一时间、任一节点、任一资源都满足
  `allocated + reserved == used <= limit`；`Check` 会从活动 hold 重新核算并验证。

## 用法

```go
import formal "example.org/dlks/formal/q10033"

calc, err := formal.NewCalculator(formal.Config{Nodes: []formal.Node{
    {ID: "root", Limit: formal.Resources{"cpu": 16}},
    {ID: "team-a", Parent: "root", Limit: formal.Resources{"cpu": 10}},
    {ID: "team-a/high", Parent: "team-a", Priority: 9, Limit: formal.Resources{"cpu": 6}},
    {ID: "team-a/low", Parent: "team-a", Priority: 1, Limit: formal.Resources{"cpu": 4}},
    {ID: "team-b", Parent: "root", Limit: formal.Resources{"cpu": 10}},
}})
if err != nil {
    log.Fatal(err)
}

// 调度预演：按请求量计算各层可用公平份额（不改变状态）。
shares, err := calc.FairShare([]formal.Demand{
    {Node: "team-a/high", Resources: formal.Resources{"cpu": 6}},
    {Node: "team-a/low", Resources: formal.Resources{"cpu": 6}},
    {Node: "team-b", Resources: formal.Resources{"cpu": 4}},
})

// 准入：全量预留，或 TryReserve 取部分。
hold, err := calc.Reserve(formal.Request{
    ID: "job-1", Node: "team-a/high", Priority: 9,
    Resources: formal.Resources{"cpu": 3},
})
if err == nil {
    _, _ = calc.Commit(hold.ID)
    defer calc.Release(hold.ID)
}

// 高优先级请求需要容量时，只回收严格更低优先级的 hold。
reclaimed, err := calc.PreemptBelow("root", 9, formal.Resources{"cpu": 2})
```

## 验证

测试包含：

- 整数分摊与随机属性检查；
- 小配额拓扑上所有请求排列、操作序列的穷举；
- 与朴素线性参考解的逐层授予量对照；
- 抢占的稳定优先级、整数分摊与守恒检查；
- 并发预留/提交/释放/抢占交错时的快照重算，验证总量不重不漏。

运行：

```sh
go test ./...
go test -race ./...
```
