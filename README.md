自动伸缩控制面需要供HPA扩展器调用的Go聚合库，同时处理多指标缺失、未就绪 Pod、扩容与缩容不同稳定窗口以及速率策略。历史建议过期时精确淘汰，缩容取窗口内最保守值。用乱序样本、时间跳变和副本边界验证结果与朴素事件重放一致。

## 库结构

- `Controller`（`controller.go`）：增量聚合器，供 HPA 扩展器调用。事件流式进入，`Evaluate` 输出建议副本数。
- `Naive`（`naive.go`）：朴素参照实现，每次评估都完整重放事件日志重建状态，用于一致性验证。
- `engine.go`：两者共享的评估管线——指标聚合 → 历史记录与精确淘汰 → 稳定窗口 → 速率策略 → 副本边界钳制。

## 语义

- **多指标**：每个指标在"就绪且上报该指标"的 Pod 上计算 `ceil(current * sum / (count * target))`，取各指标最大值；任一指标无数据则跳过，全部无数据则维持当前副本数。
- **缺失与未就绪**：未就绪 Pod（`SetPodReady(pod, false)`）与缺失某指标的 Pod 都从该指标的分子分母中剔除；未显式设置就绪态的 Pod 默认就绪。
- **乱序样本**：每个 (Pod, 指标) 流只保留时间戳最大的样本，时间戳相同则后到者胜出。
- **稳定窗口**：扩、缩容窗口独立配置；扩容取窗口内最小建议，缩容取窗口内最大（最保守）建议。条目在 `t - ts <= window` 内有效。
- **精确淘汰**：评估时淘汰年龄超过最大窗口的历史条目，边界 `age == maxWindow` 保留。
- **速率策略**：支持 `Pods`/`Percent` 策略与 `Max`/`Min`/`Disabled` 选择策略；额度按距上次评估的时长占 `PeriodSeconds` 比例折算，首次评估给予完整周期，时间回退不新增额度。
- **一致性**：`TestNaiveReplayConsistency` 用随机事件流（乱序样本、就绪翻转、非单调评估时间、越界副本数）对拍 `Controller` 与 `Naive`，要求建议与历史长度完全一致。

## 示例

```go
cfg := formal.Config{
    MinReplicas: 1,
    MaxReplicas: 50,
    Metrics:     []formal.MetricSpec{{Name: "cpu", Target: 100}},
    ScaleDown:   formal.ScalingRules{StabilizationWindowSeconds: 300},
    ScaleUp: formal.ScalingRules{
        Policies: []formal.ScalingPolicy{
            {Type: formal.PercentPolicy, Value: 100, PeriodSeconds: 60},
        },
    },
}
c := formal.NewController(cfg)
c.AddSample(time.Now().Unix(), "pod-1", "cpu", 250)
c.SetPodReady("pod-2", false)
rec := c.Evaluate(time.Now().Unix(), 4) // rec.Replicas 为最终建议
```

## 测试

```sh
go test ./...
```
