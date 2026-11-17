# 资源编排执行库

供云平台控制面资源编排服务调用的 Go 执行库。它按依赖 DAG 并行执行创建、更新和删除，并在失败时以逆拓扑序补偿已生效且可逆的节点。

## 使用

```go
plan := formal.Plan{
    ID:         "stack-42",
    Generation: 1, // 重试时必须严格递增
    Nodes: []formal.Node{
        {ID: "vpc", Action: formal.ActionCreate, Reversible: true},
        {ID: "subnet", Action: formal.ActionCreate, Deps: []string{"vpc"}, Reversible: true},
        {ID: "db", Action: formal.ActionCreate, Deps: []string{"subnet"}},
    },
}

exec, err := formal.NewExecutor(provider) // provider 实现 formal.Backend
if err != nil {
    return err
}
report, err := exec.Execute(ctx, plan)
```

编排服务也可以先调用 `Start`，再调用 `Run.Wait`，以便在等待期间做其他工作。

## 语义

- **并行与依赖**：没有未完成依赖的节点会立即提交，彼此独立的节点并发执行；节点只有在其全部依赖成功后才会启动。
- **生效与补偿**：`Apply` 即使返回错误，也可以用 `Effected=true` 表示变更已经提交。失败后只补偿 `Effected=true` 且 `Reversible=true` 的节点。
- **补偿顺序**：按逆拓扑序执行；只有依赖它的有效节点全部补偿成功后，才允许补偿该节点。不可逆节点或补偿失败的节点会让其依赖保持 `retained`，避免误删仍被引用的资源。
- **唯一终态**：每次执行最终只会处于 `succeeded`、`failed` 或 `superseded` 之一；重复、迟到或乱序的回调不会改变终态。
- **操作代次**：同一 `Plan.ID` 的 `Generation` 必须严格递增。启动新代次会围栏旧代次，旧代次的回调直接丢弃（`Executor.RejectedCallbacks` 会计数）。

`Run.Trace()` 返回带单调序号的调度轨迹，可用于审计和验证依赖顺序、终态及补偿逆序。

## 验证

测试对 4 节点菱形 DAG 枚举了全部 `3^4` 种应用故障组合（成功、生效前失败、生效后失败），并组合枚举 `2^4` 种可逆性与 5 种补偿故障点，检查：

- 依赖成功先于后继启动；
- 每次运行恰好一个终态，重复回调不改变终态；
- 补偿严格按逆拓扑序，且只覆盖已生效、可逆、未被不可逆后继阻塞的节点。

```sh
go test ./...
go test -race ./...
```
