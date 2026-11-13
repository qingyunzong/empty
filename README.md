# 数据质量规则依赖执行

质量平台需要可导入的 Go 规则执行规划库，规则声明输入列、前置规则和产生的派生列。构建依赖 DAG，循环返回最小环；批次内独立规则并行但结果按稳定顺序发布。前置失败可 skip 或 continue，由规则策略决定且不能被当作通过。

## 用法

```go
rules := []dataeng.Rule{
    {ID: "parse", Produces: []string{"amount"}, Run: parseAmount},
    {ID: "range", Inputs: []string{"amount"}, DependsOn: []string{"parse"}, Run: checkRange},
    {ID: "audit", Inputs: []string{"raw"}, OnDepFailure: dataeng.ContinueOnDepFailure, Run: audit},
}
plan, err := dataeng.Build(rules, []string{"raw"}) // 依赖成环时 err 为 *CycleError（最小环）
if err != nil { /* ... */ }
for _, res := range plan.Execute(ctx) { // 批内并行，结果按声明顺序
    fmt.Println(res.RuleID, res.Status) // passed / failed / skipped
}
```

- `Rule` 声明 `Inputs`（输入列）、`DependsOn`（前置规则）、`Produces`（派生列）。
- `Build` 校验重复 ID、未知依赖、派生列冲突、输入列可用性，并按拓扑层级分批。
- 前置未通过时默认 `SkipOnDepFailure`（标记 `StatusSkipped`，绝不视为通过，且继续阻断下游）；`ContinueOnDepFailure` 则照常执行。
