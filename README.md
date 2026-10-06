# faultinj

按作用域叠加的失败注入库（Go）。

## 语义

- **作用域叠加**：`WithScope` 在 `context.Context` 上叠加规则，内层作用域优先于外层。
- **退出恢复**：返回的 `exit()` 幂等、可 `defer`；正常退出或 panic 展开都会恢复父级规则。
- **并发隔离**：作用域链随 context 派生，各 goroutine 互不污染。
- **一次命中即耗尽**：规则消费是原子的，命中一次后失效，操作回落到外层规则。
- **命中账**：`Ledger` 记录每次实际命中（规则、作用域、操作、序号），`Report()` 输出账单。
- **屏障**：`Barrier` 可复用，用于测试中以确定性交错验证嵌套与并发隔离。

## 用法

```go
inj := faultinj.New()
rule := faultinj.NewRule("db-down", errBoom, faultinj.MatchOp("db.read"))

ctx, exit := inj.WithScope(context.Background(), "request", rule)
defer exit()

if err := inj.Check(ctx, faultinj.Op("db.read")); err != nil {
    // 注入失败生效
}
fmt.Print(inj.Ledger().Report())
```

## 测试

```sh
go test ./...
```
