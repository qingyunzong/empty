# Count-Min 重打击者候选

流量分析服务会调用可导入的 Go Count-Min heavy hitter 组件，在固定内存内维护估计计数与候选集。hash seed、宽深和衰减世代显式配置；合并只接受相同参数。候选漏报界限由总权重和误差参数验证，负更新仅在 strict turnstile 条件下允许。

## 用法

```go
s, _ := dataeng.New(dataeng.Config{
    Width: 512, Depth: 5, Seed: 42, Epsilon: 0.01, Decay: 0.5,
})
_ = s.Add("flow-a", 1)          // 负 delta 仅在 strict turnstile 下允许
est := s.Estimate("flow-a")
hh := s.Candidates()            // 至多 ceil(1/Epsilon) 个候选，按估计降序
bound := s.MissBound()          // = Epsilon * TotalWeight，超过即保证不漏报
s.AdvanceGeneration()           // 按 Decay 衰减并递增世代
err := s.Merge(other)           // 仅接受相同 Config 与相同世代
```
