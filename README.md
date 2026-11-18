服务网关需要可嵌入的Go流量拆分组件，按模型版本百分比分配请求并管理 canary 与影子比较，处理回滚。各版本接收比例守恒且与配置一致，影子流量不影响正式响应，回滚只让新请求切换、在途请求保持原版本。用请求序列穷举，对照朴素比例分配核对每版本计数，回滚与版本切换交错时不重复计数。

## 组件概览

包 `formal` 提供可直接嵌入网关的并发安全流量拆分器，零外部依赖。

- `Splitter`：按版本权重做百分比路由，维护正式/影子/在途三类计数。
- `Assignment`：一次路由决策，在 `Release` 前钉住被分配的版本。
- `Dispatcher`：在 `Splitter` 之上派发“正式 + 影子”调用，影子错误与 panic 不影响正式响应。

## 分配算法与比例保证

正式版本（`RoleStable` / `RoleCanary`）权重之和必须为 100；`RoleShadow` 不参与
正式权重。`Route` 使用在线赤字法（最大余数法的顺序形式）：

- 每个版本维护赤字 `deficit = w*n - 100*allocated`，每来一个请求加 `w`，
  被选中后减 100；始终选择赤字最高的版本，平局按权重再按配置顺序决出。
- 总和守恒：每个请求恰好计入一个正式版本。
- 偏差保证：任意前缀上 `|count - w*n/100| < 2`，且在 100 的整数倍处
  `count` 与配置权重精确相等。无状态在线算法无法在每个前缀复现 Hamilton
  全局整数解（无法预知未来请求数），上述偏差界是在线比例分配的可验证标准。

## 回滚与在途语义

- `UpdateConfig` / `Rollback` 是配置替换，只影响之后的新请求。
- 已发出的 `Assignment` 保持被路由时的版本，其 `Release` 作用于原版本的在途计数。
- `Release` 由 `sync.Once` 保护，重复调用幂等，切换与完成交错时不会重复计数。
- 每次成功切换递增 `Generation`，失败的校验不改变当前代数。

## 影子流量

- `Route` 同时返回全部影子版本 ID，并只累加影子计数。
- `Dispatcher` 对影子调用做 panic 恢复；异步模式用 `context.WithoutCancel`
  与正式请求解耦，`Close` 等待在途影子调用结束。

## 用法

```go
cfg := formal.Config{Versions: []formal.Version{
    {ID: "stable", Role: formal.RoleStable, Weight: 80},
    {ID: "canary", Role: formal.RoleCanary, Weight: 20},
    {ID: "shadow", Role: formal.RoleShadow, Weight: 0},
}}
splitter, _ := formal.NewSplitter(cfg)
dispatcher := formal.NewDispatcher(splitter, formal.HandlerFunc(handle))

dec := dispatcher.Dispatch(ctx, request)
defer dec.Assignment.Release()
// dec.Response 是正式响应；影子结果永不进入这里。

_ = splitter.Rollback(stableConfig) // 仅新请求切换，在途请求不受影响
```

## 测试

- `TestExhaustiveProportions`：穷举全部 3 版本权重组合（和为 100）与请求前缀，
  对照独立计算的朴素比例期望核对每版本计数、偏差界与守恒。
- `TestCanaryAndShadowProportions` / `TestDispatcherShadowIsolation`：
  影子与正式计数隔离，影子报错或 panic 不污染正式响应。
- `TestRollbackInterleave`：随机穷举路由/完成/切换/回滚交错序列，
  验证在途钉住、`Release` 幂等、按代比例守恒且无重复计数。
- `TestConcurrentRouting`：`-race` 下并发路由与回滚，验证无竞争且计数守恒。
