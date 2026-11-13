# 429 多作用域退避合并

采集调度器要可直接接入 Go 限流反馈库，响应可同时携带全局、租户、资源和方法级 reset。每个请求受相关作用域最大截止时间约束，成功响应只更新明确给出的桶；时钟偏差和过期日期有界校正。取消等待不消耗令牌。

## 用法

```go
sched := dataeng.NewScheduler(dataeng.WithMaxSkew(30 * time.Second))
route := dataeng.Route{Tenant: "acme", Resource: "repos", Method: "GET"}

// 每个请求前：等待所有相关作用域放行（取最大 reset 截止时间），
// ctx 取消时不消耗任何令牌。
if err := sched.Wait(ctx, route); err != nil {
    return err
}
resp, err := client.Do(req)
...

// 响应后：解析响应头并只更新明确给出的桶。
sched.Update(route, dataeng.ParseFeedback(resp.Header, time.Now()))
```

## 语义

- **作用域**：全局、租户、资源、方法四级桶；`Route` 决定一次请求涉及哪些桶。
- **合并**：`Wait` 按相关作用域中最大的 reset 截止时间阻塞，放行后才从每个相关桶各扣一个令牌。
- **反馈**：`Feedback` 中 nil 的 hint 表示响应未提及该作用域，对应桶保持原状。
- **校正**：服务器 `Date` 与本地时钟的偏差最多信任 `WithMaxSkew`（默认 30s）；已过期的 reset 时间被钳制到当前时刻，不会把桶的截止时间倒退。
- **取消**：`Wait` 在 ctx 取消时返回 `ctx.Err()`，不消耗令牌、不触发 refill。

## 识别的响应头

- `Date`：服务器时钟，用于偏差校正
- `Retry-After`：全局节流信号（秒或 HTTP-date）
- `RateLimit-Limit/Remaining/Reset`（及 `X-RateLimit-*`）：全局作用域
- `X-RateLimit-*-Tenant` / `-Resource` / `-Method`：对应作用域

reset 值支持 HTTP-date、unix 时间戳（≥ 1e9）或相对秒数。
