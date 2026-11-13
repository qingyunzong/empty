# 差分隐私预算组合

分析平台需要可导入的 Go 隐私预算会计库，按数据集、用户域和机制记录 epsilon/delta 或 RDP 曲线。预算预留、查询成功、取消和超时竞争时只结算一次；并发申请原子裁决。不同 alpha 的 RDP 组合后转换取最优界，不能把失败请求算作已发布。

## 用法

```go
acc := dataeng.NewAccountant()
key := dataeng.Key{Dataset: "clicks", Domain: "eu-users", Mechanism: "gaussian"}

// 配置预算：纯 (ε,δ) 上限 + 各阶 RDP 上限
acc.SetBudget(key, dataeng.Budget{
    Epsilon: 1.0,
    Delta:   1e-5,
    RDP:     map[float64]float64{2: 4, 10: 12},
})

// 原子裁决：检查 + 占用在同一把锁内完成，并发申请不会超支
res, err := acc.Reserve(key, dataeng.Cost{
    RDP: map[float64]float64{2: 0.5, 10: 1.5},
}, 30*time.Second) // ttl>0 超时自动释放
if err != nil {
    // ErrInsufficientBudget / ErrNoBudget / ErrInvalidCost
}

// 恰好结算一次：成功 Commit；失败/取消 Release；超时自动 Expired
if err := res.Commit(); err != nil { /* 已结算或已过期 */ }
// defer res.Release() // 失败路径：不计入已发布

// 组合后按目标 delta 取所有 alpha 上的最优 (ε,δ) 界
eps, delta, err := acc.PublishedEpsilon(key, 1e-5)
```

- `Spent` / `Held` / `Remaining` 分别查询已结算、预留中、剩余的预算。
- 失败的查询只要 `Release`（或任其过期），不会计入 `Spent`。
