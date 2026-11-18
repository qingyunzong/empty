删除控制器需要供终态清理流程调用的Go协调账本，为每个对象登记多个终态键的顺序、外部资源清理确认与重试。外部操作的在途确认与删除事件竞争时，资源清理结果必须恰好登记一次，只有全部外部资源确认完成后才能移除对应终态键；对象在清理期间被重新添加终态键不得让已完成项重跑。用故障点枚举与事件重放，核对每个外部资源在终态键移除前恰有一次成功记录，重试与取消交错时不出现孤儿资源或重复清理。

## 使用

```go
ledger := formal.NewLedger()

// 按顺序登记终态键及其外部资源。
_ = ledger.Register("obj",
    formal.KeySpec{Key: "k1", Resources: []formal.ResourceID{"r1", "r2"}},
    formal.KeySpec{Key: "k2", Resources: []formal.ResourceID{"r3"}},
)

_ = ledger.BeginCleanup("obj") // 可在删除事件之前开始
effects, _ := ledger.Reconcile("obj")
// effects 中只有 k1 的 StartCleanup；之后的键必须等待 k1 移除。

for _, effect := range effects {
    if effect.Kind == formal.EffectStartCleanup {
        // 执行外部清理，完成后调用：
        _, _ = ledger.Confirm("obj", effect.Resource, effect.Attempt,
            formal.ResultSucceeded)
    }
}

_ = ledger.Delete("obj")
effects, _ = ledger.Reconcile("obj")
// 全部资源确认成功后才会产生 RemoveKey / FinishObject。
```

## 保证

- `Register` 是增量登记：重复添加已存在的键不会重置已完成资源，键在清理期间被重新添加时不会重跑已完成项。
- 终态键严格按首次登记顺序处理；后一个键的资源只在前一个键移除后才启动。
- 成功确认单调且幂等：同一资源无论被确认多少次，成功记录始终恰好一次；即使确认与 `Delete` 并发，键也不会在成功记录之前被移除。
- `Retry` 只重排队失败项，`Cancel` 只重排队未成功项；不会重跑已完成项。取消后的资源由下一次 `Reconcile` 重新启动，因此不会留下孤儿。
- 每个事件都进入持久事件日志；`Replay` 可重建完全相同的状态与尝试号。

测试包含并发竞态、顺序/重试/取消用例，以及对所有可达交错（含删除、失败、取消、重试、重新登记和每次 `Reconcile`）的故障点枚举。枚举器在每个状态重放事件日志，并检查键移除前每个资源恰有一次成功记录、无孤儿资源、无重复清理。
