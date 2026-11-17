# 渐进交付序贯控制组件

`formal` 是一个可嵌入发布平台的 Go 控制组件。发布流程把对照组与实验组的样本流交给它，
组件按指标做序贯检验，返回 `scale_up`、`hold` 或 `rollback`，并由调用方通过
`Execute` 记录实际执行的动作。

组件没有时钟、随机数或后台协程；相同输入流必然得到相同决策。

## 快速使用

```go
engine, err := formal.New(formal.Config{
    Alpha: 0.05,
    Metrics: []formal.MetricSpec{
        {Name: "success", Kind: formal.KindProportion, Direction: formal.HigherIsBetter, MinSamplesPerArm: 200},
        {Name: "latency_ms", Kind: formal.KindContinuous, Direction: formal.LowerIsBetter, MinSamplesPerArm: 200},
    },
    TrafficSteps: []float64{1, 5, 10, 25, 50, 100},
})
if err != nil {
    return err
}

// 延迟到达或修正后的样本也可以安全重放：ID 相同即覆盖。
if err := engine.Backfill(observations...); err != nil {
    return err
}

decision := engine.Evaluate() // 只计算和推荐，不改变执行状态
if err := engine.Execute(decision.Action); err != nil {
    return err
}
```

`Step` 等价于在同一个锁内执行 `Evaluate` 加 `Execute`，适合简单控制循环。
每次 `Evaluate` 在最小样本达标后都计为一次 look；不要在高频轮询中无条件调用，
应按检查点调用，因为无新数据的重复窥视同样会消耗误报预算。

`Observation` 是统计单元：比例指标取 0/1，连续指标比较单元均值。若平台 SLI 本身
是窗口级 p99，应把每个窗口的 p99 作为一条观测并保证两臂窗口口径一致，而不是把
原始请求延迟样本命名为 p99。

## 决策语义

| 条件 | 动作 |
| --- | --- |
| 任一指标达到最小样本且显著变差 | `rollback`，目标流量为 0 |
| 所有指标达到最小样本、至少一个显著变好、且没有显著变差 | `scale_up`，目标为下一档流量 |
| 有指标未达到最小样本，且没有显著变差 | `hold`，继续采样 |
| 无显著差异 | `hold` |
| 显著变好但已在最高档 | `hold` |

显著变差优先于其他条件，因此一个安全指标改善不能掩盖另一个指标的回归。放量要求
所有指标都达到最小样本，避免只看到部分指标就扩大流量。

## 序贯检验与总体误报界

第 `m` 个指标获得归一化权重 `w_m`，分配

`α_m = α · w_m / Σw`。

该指标第 `k` 次检验使用水平

`α_{m,k} = α_m / (k(k+1))`。

因为 `Σ_{k≥1} 1/(k(k+1)) = 1`，每个指标跨所有 look 的总预算不超过 `α_m`；
再对所有指标求和，总预算不超过 `α`。由并集界：

`P(任意指标在任意 look 误报) ≤ Σ_m Σ_k α_{m,k} ≤ α`。

这个界不要求各指标独立，也不要求 look 的时间或样本量均匀，因此同样覆盖
按需重算和延迟回补。代价是越到后面的 look 阈值越严格，重复窥视会被自动惩罚。

每次检验使用双侧正态临界值 `z_{1-α_{m,k}/2}`。比例指标使用合并方差双比例
z 检验；连续指标使用 Welch 标准误。`MinSamplesPerArm` 之前不消耗 look，也不会
产生显著结论。该保证依赖正态近似，重尾连续 SLI 应先做有界聚合或取足够大的最小
样本。双侧检验同时覆盖变差与变好，两个方向共享该 look 的 `α_{m,k}`。

## 回补与回滚不可逆

- `Observation.ID` 非空时，`Add`/`AddBatch`/`Backfill` 按“指标 + ID”覆盖旧值，
  不会重复计数；同一 ID 不允许切换实验组。
- 每次 `Evaluate` 都从保留的全量样本重新计算均值和方差，因此延迟数据、乱序数据
  与重复投递都能反映到下一次决策。
- 回滚只有在 `Execute(Rollback)`（或 `Step` 返回回滚）之后才成为既定事实。此后
  回补仍会更新 `Decision.Metrics` 中的统计量，但动作永久保持 `rollback`，
  `TrafficPercent()` 保持 0，`Execute(ScaleUp)` 返回 `ErrRollbackLocked`。

## 可重复验证

```sh
go test ./... -count=1
```

测试使用固定种子的样本流覆盖：

- 明显改善触发放量，并校验下一档流量；
- 同分布流保持 `hold`；
- 明显回归触发回滚；
- 成功率改善但延迟回归时仍回滚；
- 最小样本达到前不决策、不消耗 alpha；
- 1000 次同分布、多指标、相关指标的试验中总体误报率低于 `Alpha`；
- `Alpha` 增大时误报率随之上移但仍受限；
- 未执行回滚前回补可改变建议，执行后回补只能更新统计量；
- 相同输入流逐 look 产生完全相同的决策。

误报界测试会打印实测值，例如 `Alpha=0.05`、1000 次试验、3 个相关指标时典型结果
约为 1%–2%，低于配置的 5%。
