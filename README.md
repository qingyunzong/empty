# SLO 双窗口燃烧率组件

供告警评估器调用的 Go 包。它从乱序到达的 SLI 增量桶中维护短、长两个窗口，计算燃烧率与预算消耗，并用成对窗口条件驱动告警状态机。

## 数据与窗口约定

- `Bucket{Start, Total, Errors}` 表示 `[Start, Start+BucketWidth)` 内的请求数和违例数，不是累计计数器。
- 桶可以任意顺序写入。`Upsert` 对相同 `Start` 做幂等替换，因此重试不会重复计数，迟到修正可以回补空洞。`Store.Revision` 在数据真正变化时递增。
- 评估时刻 `at` 先截断到桶边界，得到 `cut = at.Truncate(BucketWidth)`。窗口为 `[cut-W, cut)`，只使用已经完整的桶；当前未结束的桶永不参与计算。
- `ShortWindow`、`LongWindow` 都必须是 `BucketWidth` 的整数倍，且长窗不短于短窗。

## 缺测与新鲜度

- `Coverage = 实际存在桶数 / 应有桶数`，低于 `MinCoverage` 时窗口不可用。
- 窗口内最新桶的结束时间距 `cut` 超过 `MaxStaleness` 时视为陈旧。默认值 `0` 要求紧邻 `cut` 的最后一个桶必须存在，避免尾部缺测仍按旧数据告警。
- 任一同伴窗口不可用时，评估进入“保持”语义：未触发不会新触发，已触发不会因缺数据而恢复。缺测不是恢复证据。

## 燃烧率与自然日目标

目标由 `TargetSchedule` 提供，按 `Location` 下的自然日查找；桶按其 `Start` 所在自然日取目标。跨越午夜的目标变更应按桶逐点计入预算：

```text
AllowedErrors = Σ total_i × (1 - target(day_i))
BurnRate      = Σ errors_i / AllowedErrors
```

`BudgetConsumed` 与 `BurnRate` 同值，表示窗口内消耗的误差预算比例。`TargetEffective` 是事件加权的等效目标；窗口无事件时退回时间加权目标。建议让桶宽整除一天，避免单个桶跨午夜时目标归属含糊。

## 告警状态机

- 触发：短窗和长窗的燃烧率都 **严格大于** `FireThreshold`。等于阈值不触发。
- 恢复：两个窗口都 **小于等于** `RecoverThreshold` 才进入恢复观察；`RecoverThreshold` 必须严格低于触发阈值，形成滞回。
- `RecoverFor > 0` 时，需要连续满足恢复条件达到该时长才清除。重复评估同一时刻不会重复累计。
- 缺测会重置恢复观察计时，只有连续可观测的健康窗口才能清除告警。
- 评估时间必须单调不减；同一时刻可在回补后重复评估。时钟通过 `Clock` 注入，测试使用 `ManualClock`。

## 用法

```go
clock := formal.NewManualClock(time.Date(2026, 11, 18, 10, 10, 0, 0, time.UTC))
evaluator, err := formal.NewEvaluator(formal.Config{
    BucketWidth:      time.Minute,
    ShortWindow:      5 * time.Minute,
    LongWindow:       time.Hour,
    FireThreshold:    14.4,
    RecoverThreshold: 7.2,
    MinCoverage:      0.9,
    MaxStaleness:     time.Minute,
    RecoverFor:       5 * time.Minute,
    Targets: formal.TargetSchedule{
        Location: time.UTC,
        Default:  0.999,
        Daily:    map[string]float64{"2026-11-19": 0.9995},
    },
}, clock)
```

处理桶、评估并读取状态：

```go
changed, err := evaluator.Ingest(formal.Bucket{
    Start:  bucketStart,
    Total:  requests,
    Errors: failures,
})
result, err := evaluator.EvaluateNow()
if result.Transition == formal.TransitionFired {
    // 发出告警
}
_ = changed
_ = err
```

## 验证

```sh
go vet ./...
go test -race ./...
```

测试使用 `ManualClock` 推进虚拟时间，并用独立的逐桶朴素聚合器做 300 轮随机差分校验。覆盖了严格触发边界、短窗单独越阈不触发、滞回区保持、恢复观察、缺测保持与计时重置、乱序/迟到回补、跨自然日目标变更及预算消耗。
