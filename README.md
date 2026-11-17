# 发布副本规划库

供发布管理器调用的 Go 规划库。它根据期望副本、`maxSurge`、`maxUnavailable`、就绪延迟和终止宽限，为每一步生成一个扩缩动作。发布管理器应用动作后，把新的聚合状态作为 `Observation` 传回，规划器再计算下一步。

## 快速使用

```go
planner, err := formal.NewPlanner(formal.Policy{
    DesiredReplicas:  10,
    MaxSurge:         formal.Percent(20), // 向上取整 => 2
    MaxUnavailable:   formal.Percent(20), // 向下取整 => 2
    ReadinessDelay:   30 * time.Second,
    TerminationGrace: 60 * time.Second,
})
if err != nil {
    return err
}

decision, err := planner.Step(formal.Observation{
    Now:         0,
    Total:       10,
    Available:   10,
    Terminating: 0,
    Capacity:    12, // 当前可容纳的 Pod 总数
})
if err != nil {
    return err
}

switch decision.Action.Kind {
case formal.ActionScaleUp:
    // 创建 decision.Action.Replicas 个 Pod；
    // 预计 decision.Action.ReadyAt 时就绪。
case formal.ActionScaleDown:
    // 立即开始 decision.Action.Replicas 个终止；
    // decision.Action.TerminateUnready / TerminateReady 给出拆分；
    // decision.Action.CompleteBy 前不得撤回。
}
```

## 状态含义

- `Total`：尚未完成删除的 Pod 总数，包含未就绪和正在终止的 Pod。终止中的 Pod 仍占用节点容量。
- `Available`：已就绪且未开始终止的 Pod 数。开始终止即从可用数中扣除，避免终止宽限结束时可用数突然跌破下限。
- `Terminating`：已开始终止、尚未完成删除的 Pod 数。
- `Capacity`：当前节点容量上限。`0` 表示真实容量为零；不限制容量时使用 `formal.UnlimitedCapacity`。

## 规划规则

- 稳定目标为 `min(desiredReplicas, capacity)`，总上限为
  `min(desiredReplicas + maxSurge, capacity)`。
- 可用数下限为 `max(0, desiredReplicas - maxUnavailable)`。
- 缩容优先选择未就绪 Pod；只有当可用数高于下限时才终止就绪 Pod。任何动作都不会主动把可用数推到下限以下。
- 可用数不足时，在有 `maxSurge` 余量的前提下扩容补偿。
- `maxSurge` 的整数百分比向上取整，`maxUnavailable` 的整数百分比向下取整。两者都省略（均为 0）时，按 Kubernetes 默认值 25%/25% 处理。
- 容量下降时，规划器用新的 `Capacity` 重新计算目标；已经开始的终止记录在 `PendingTerminations` 中，只会等到各自的 `Deadline` 过期，不会被取消或提前移除。
- `UpdatePolicy` 可以修改期望副本或策略。已有终止批次的 `Deadline` 保持不变；新的终止宽限只影响之后开始的批次。
- 容量低于可用数下限时，`Decision.Feasible` 为 `false`。规划器优先保持可用性，不会为了贴合容量而突破下限；容量恢复后继续收敛。

调用约定：每一步只应用一个 `Decision`，应用后再观测并调用 `Step`。规划器没有取消终止的 API。

## 验证

`go test ./...` 覆盖：

- Kubernetes 百分比取整的整数边界（含 1%、9%、33%、100% 和小副本数）；
- 容量骤降、容量低于可用下限、容量恢复；
- 就绪在预算内反复抖动，以及超出预算后恢复；
- 终止期间再次缩容、修改策略、容量变化时终止批次不被撤回；
- 仿真中逐步断言可用数不越界、缩容不前推可用数下限，并最终收敛。

```sh
go test ./...
go test -race ./...
```
