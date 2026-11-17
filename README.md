节点代理需要供资源管理器调用的Go驱逐决策库，综合内存、inode、磁盘和PID压力，按请求用量、优先级、QoS与终止成本稳定排序。压力解除时停止新增驱逐但不撤销已发终止。用候选集合穷举验证排序规则、最小释放集合和并列确定性。

## 用法

```go
m := &eviction.Manager{Thresholds: eviction.Resources{
    eviction.ResourceMemory: 100 << 20, // 可用量低于阈值即视为压力
    eviction.ResourceDisk:   1 << 30,
    eviction.ResourceInodes: 1000,
    eviction.ResourcePIDs:   64,
}}
decision := m.Plan(pods, available)
// decision.Pressures: 受压资源（固定顺序）
// decision.Evict:    新选中的驱逐对象，按驱逐顺序
// decision.InFlight: 已在终止中的 Pod，不撤销、不重复选择
// decision.Relieved: 终止完成后压力是否全部解除
```

排序规则：QoS 等级低者优先，其次优先级低者，其次超出请求用量多者，
其次终止成本低者，最后按名称定序保证完全确定。压力解除或在途终止
已足够时不再新增驱逐。测试见 `eviction/` 下的单元测试与穷举性质测试
（全序性、排列不变性、最小释放集合、并列确定性）。
